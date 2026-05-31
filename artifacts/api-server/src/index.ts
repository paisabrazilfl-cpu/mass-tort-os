import app from "./app";
import { logger } from "./lib/logger";
import { seedFormConfigurations } from "./lib/form-config-service";
import { seedDefaultFirm, seedSuperAdmin, backfillEmailVerifiedAt } from "./lib/firm-bootstrap";
import { seedIntakeWorkflows } from "./lib/automations/seed-intake-workflows";
import { workerLoop } from "./worker";
import { db, automationWorkflowsTable } from "@workspace/db";
import { eq, and, sql } from "drizzle-orm";
import { Cron } from "croner";
import { runWorkflow } from "./lib/automations/executor";

const NODE_ENV = process.env["NODE_ENV"];
const IS_DEV = NODE_ENV === "development";
const IS_PROD_LIKE = NODE_ENV === "production" || NODE_ENV === "staging";

const REQUIRED_ENV_PROD = ["DATABASE_URL", "SESSION_SECRET"] as const;
if (IS_PROD_LIKE) {
  const missing: string[] = REQUIRED_ENV_PROD.filter(
    (k) => !process.env[k] || String(process.env[k]).trim() === "",
  );
  const hasEncryptionKey =
    Boolean(process.env["ENCRYPTION_KEY_V1"]?.trim()) ||
    Boolean(process.env["ENCRYPTION_KEY"]?.trim());
  if (!hasEncryptionKey) {
    missing.push("ENCRYPTION_KEY_V1 (or legacy ENCRYPTION_KEY)");
  }
  if (missing.length > 0) {
    logger.fatal({ missing, node_env: NODE_ENV }, "FATAL: required environment variables missing");
    throw new Error(
      `Refusing to boot in NODE_ENV="${NODE_ENV}" without: ${missing.join(", ")}. Set these in deployment secrets.`,
    );
  }
}

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

app.listen(port, async (err) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }

  // Single grep-friendly startup banner so ops can confirm the process's
  // security posture at boot.
  logger.info(
    {
      port,
      node_env: NODE_ENV ?? "(unset)",
      dev_mode: IS_DEV,
      has_session_secret: Boolean(process.env["SESSION_SECRET"]),
      has_encryption_key:
        Boolean(process.env["ENCRYPTION_KEY_V1"]) ||
        Boolean(process.env["ENCRYPTION_KEY"]),
      has_database_url: Boolean(process.env["DATABASE_URL"]),
    },
    "MTOS API server listening",
  );

  // ── Startup schema migrations ────────────────────────────────────────────
  // Idempotent column additions for production schema drift.
  // Runs IF NOT EXISTS so safe on every boot; failures are logged but never
  // block the server from starting.
  const startupMigrations: Array<{ table: string; column: string; ddl: string }> = [
    { table: "integrations",  column: "field_mapping",       ddl: "ALTER TABLE integrations ADD COLUMN IF NOT EXISTS field_mapping JSONB" },
    { table: "integrations",  column: "firm_id",             ddl: "ALTER TABLE integrations ADD COLUMN IF NOT EXISTS firm_id INTEGER" },
    // fax_results columns added for MRR delivery tracking (may be missing on Railway)
    { table: "fax_results",   column: "external_fax_id",     ddl: "ALTER TABLE fax_results ADD COLUMN IF NOT EXISTS external_fax_id TEXT" },
    { table: "fax_results",   column: "provider",            ddl: "ALTER TABLE fax_results ADD COLUMN IF NOT EXISTS provider VARCHAR(64)" },
    { table: "fax_results",   column: "integration_id",      ddl: "ALTER TABLE fax_results ADD COLUMN IF NOT EXISTS integration_id INTEGER" },
    { table: "fax_results",   column: "delivery_status",     ddl: "ALTER TABLE fax_results ADD COLUMN IF NOT EXISTS delivery_status VARCHAR(32) DEFAULT 'pending'" },
    { table: "fax_results",   column: "delivery_checked_at", ddl: "ALTER TABLE fax_results ADD COLUMN IF NOT EXISTS delivery_checked_at TIMESTAMP" },
    // medical_records_requests table added for MRR feature
    { table: "medical_records_requests", column: "id",       ddl: "CREATE TABLE IF NOT EXISTS medical_records_requests (id SERIAL PRIMARY KEY, lead_id INTEGER NOT NULL, firm_id INTEGER, fax_result_id INTEGER, provider_name TEXT NOT NULL DEFAULT '', fax_number TEXT NOT NULL DEFAULT '', status VARCHAR(32) NOT NULL DEFAULT 'pending', fulfilled_at TIMESTAMP, response_fax_result_id INTEGER, notes TEXT, created_by INTEGER, created_at TIMESTAMP NOT NULL DEFAULT NOW(), updated_at TIMESTAMP NOT NULL DEFAULT NOW())" },
    // workflow_settings table — auto-document workflow singleton; missing on older production DBs
    { table: "workflow_settings", column: "id",              ddl: "CREATE TABLE IF NOT EXISTS workflow_settings (id SERIAL PRIMARY KEY, scope VARCHAR(100) NOT NULL UNIQUE, esign_provider_integration_id INTEGER, fax_provider_integration_id INTEGER, email_provider_integration_id INTEGER, sms_provider_integration_id INTEGER, voice_provider_integration_id INTEGER, llm_default_provider_integration_id INTEGER, llm_drafting_provider_integration_id INTEGER, default_email_from_name VARCHAR(255), default_email_from_address VARCHAR(255), default_fax_from_number VARCHAR(50), auto_send_on_approval BOOLEAN NOT NULL DEFAULT TRUE, auto_fax_doctor_on_signed_hipaa BOOLEAN NOT NULL DEFAULT TRUE, esign_resend_after_days INTEGER NOT NULL DEFAULT 3, esign_expire_after_days INTEGER NOT NULL DEFAULT 14, max_send_retries INTEGER NOT NULL DEFAULT 3, notify_on_failure_email VARCHAR(255), med_records_cover_letter_template_id INTEGER, metadata JSONB NOT NULL DEFAULT '{}', notes TEXT, updated_by_user_id INTEGER, firm_id INTEGER, created_at TIMESTAMP NOT NULL DEFAULT NOW(), updated_at TIMESTAMP NOT NULL DEFAULT NOW())" },
  ];
  for (const m of startupMigrations) {
    try {
      await db.execute(sql.raw(m.ddl));
    } catch (e) {
      logger.error({ err: e, table: m.table, column: m.column }, "Startup migration failed — continuing");
    }
  }
  logger.info({ count: startupMigrations.length }, "Startup schema migrations applied");

  // Seed/refresh form configurations from TORT_REGISTRY on boot.
  // Safe: inserts missing rows and refreshes only rows where updated_by IS NULL
  // (admin-edited rows are never overwritten).
  try {
    await seedFormConfigurations();
  } catch (e) {
    logger.error({ err: e }, "Form configuration seed failed on boot");
  }

  // Seed the single "Default Firm" required by the MVI single-firm shell
  // (Task #51 T001). Idempotent: if the slug='default' row already exists
  // this is a no-op except for any users.firm_id IS NULL backfill. We must
  // do this BEFORE the subscription gate or billing routes can serve real
  // traffic, otherwise getFirmIdForUser() would return null for users that
  // pre-date the firm_id column.
  try {
    await seedDefaultFirm();
  } catch (e) {
    logger.error({ err: e }, "Default firm seed failed on boot");
  }

  // Seed the three intake-to-medical-records automation workflows (one per
  // lead-entry flow). Idempotent and seeded disabled — operators fill in
  // per-firm e-sign template ids in the Automations editor, then enable.
  try {
    await seedIntakeWorkflows();
  } catch (e) {
    logger.error({ err: e }, "Intake automation workflows seed failed on boot");
  }

  // Super-admin bootstrap — no-op unless SEED_ADMIN_EMAIL + SEED_ADMIN_PASSWORD are set.
  // Set those secrets to create/reset the super-admin on a fresh production DB,
  // then remove them after first login.
  try {
    const seedResult = await seedSuperAdmin();
    if (!seedResult.skipped) {
      logger.info(seedResult, "Super-admin seed complete");
    }
  } catch (e) {
    logger.error({ err: e }, "Super-admin seed failed on boot");
  }

  // Email-verification backfill (Task #56). Marks legacy user rows as
  // verified using their original created_at, so accounts that pre-date
  // the verification gate keep working. Idempotent — only matches rows
  // with no token hash and no existing verified_at.
  try {
    await backfillEmailVerifiedAt();
  } catch (e) {
    logger.error({ err: e }, "Email verification backfill failed on boot");
  }

  // In production (autoscale), the standalone worker workflow does not run —
  // only the API server container is started. Run the job-queue worker loop
  // inside this same process so e-sign / fax / email jobs are actually
  // processed when leads are approved.
  // In development the dedicated "MTOS Worker: Job Processor" workflow handles
  // jobs, so we skip the inline worker to avoid duplicate processing.
  // Override with INPROC_WORKER=1 (force on) or INPROC_WORKER=0 (force off).
  const inprocOverride = process.env["INPROC_WORKER"];
  const shouldRunInprocWorker =
    inprocOverride === "1" ||
    (inprocOverride !== "0" && process.env["NODE_ENV"] === "production");

  if (shouldRunInprocWorker) {
    logger.info("Starting in-process worker loop (production / INPROC_WORKER=1)");
    workerLoop().catch((err) => {
      logger.error({ err }, "In-process worker loop crashed");
    });
  } else {
    logger.info("In-process worker disabled (dev mode — separate worker workflow handles jobs)");
  }

  // ── trigger.schedule cron poller ──────────────────────────────────────────
  // Polls every 60 s and fires any enabled trigger.schedule automation whose
  // cron expression matches the current minute. Uses `croner` for expression
  // parsing; fires workflows asynchronously so slow automations never block
  // the poller itself.
  //
  // Scheduling semantics: we compare the next run time of the expression
  // against now + 60 s. If the next run falls within that window, this
  // invocation of the poller is responsible for firing it. This means at
  // most one fire per minute for any given cron expression, with ≤ 1 s jitter
  // from the setInterval drift.
  function shouldFireCron(expr: string): boolean {
    try {
      const job = new Cron(expr, { paused: true });
      const next = job.nextRun();
      if (!next) return false;
      const diff = next.getTime() - Date.now();
      return diff >= 0 && diff < 60_000;
    } catch {
      return false;
    }
  }

  setInterval(async () => {
    try {
      const rows = await db
        .select()
        .from(automationWorkflowsTable)
        .where(
          and(
            eq(automationWorkflowsTable.enabled, true),
            eq(automationWorkflowsTable.trigger_type, "trigger.schedule"),
          ),
        );
      for (const wf of rows) {
        const cron = (wf.trigger_config as Record<string, unknown>)?.cron;
        if (typeof cron === "string" && shouldFireCron(cron)) {
          runWorkflow({
            workflowId: wf.id,
            firmId: wf.firm_id,
            triggerSource: "schedule",
            input: {},
          }).catch((err) => {
            logger.error({ err, workflowId: wf.id, cron }, "schedule trigger run failed");
          });
        }
      }
    } catch (err) {
      logger.error({ err }, "schedule poller error");
    }
  }, 60_000);
  logger.info("trigger.schedule cron poller started (60s interval)");
});
