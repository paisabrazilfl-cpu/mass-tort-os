import app from "./app";
import { logger } from "./lib/logger";
import { seedFormConfigurations } from "./lib/form-config-service";
import { seedDefaultFirm, seedSuperAdmin, backfillEmailVerifiedAt } from "./lib/firm-bootstrap";
import { workerLoop } from "./worker";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";

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


// ─── Schema repair migration (idempotent ALTER TABLE IF NOT EXISTS) ──────────
// Runs at boot to add columns that were added to Drizzle schema after the
// table was first created via drizzle-kit push. Safe to run every boot.
async function runSchemaRepair(): Promise<void> {
  const repairs: string[] = [
    // automation_workflows — columns added post-initial-creation
    `ALTER TABLE automation_workflows ADD COLUMN IF NOT EXISTS tags jsonb NOT NULL DEFAULT '[]'`,
    `ALTER TABLE automation_workflows ADD COLUMN IF NOT EXISTS trigger_config jsonb NOT NULL DEFAULT '{}'`,
    `ALTER TABLE automation_workflows ADD COLUMN IF NOT EXISTS trigger_type varchar(40) NOT NULL DEFAULT 'manual'`,
    `ALTER TABLE automation_workflows ADD COLUMN IF NOT EXISTS description text`,
    `ALTER TABLE automation_workflows ADD COLUMN IF NOT EXISTS created_by_user_id integer`,
    `ALTER TABLE automation_workflows ADD COLUMN IF NOT EXISTS firm_id integer`,
    // automation_runs — make sure all columns exist
    `ALTER TABLE automation_runs ADD COLUMN IF NOT EXISTS trigger_source varchar(40) NOT NULL DEFAULT 'manual'`,
    `ALTER TABLE automation_runs ADD COLUMN IF NOT EXISTS step_log jsonb NOT NULL DEFAULT '[]'`,
    `ALTER TABLE automation_runs ADD COLUMN IF NOT EXISTS output jsonb`,
    `ALTER TABLE automation_runs ADD COLUMN IF NOT EXISTS firm_id integer`,
    `ALTER TABLE automation_runs ADD COLUMN IF NOT EXISTS started_by_user_id integer`,
    `ALTER TABLE automation_runs ADD COLUMN IF NOT EXISTS completed_at timestamp`,
    // api_keys — make sure revoked_at exists (not the old boolean revoked)
    `ALTER TABLE api_keys DROP COLUMN IF EXISTS revoked`,
    `ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS revoked_at timestamp`,
    // api_key_audit — ensure table exists
    `CREATE TABLE IF NOT EXISTS api_key_audit (
       id serial PRIMARY KEY,
       api_key_id integer NOT NULL REFERENCES api_keys(id) ON DELETE CASCADE,
       route text NOT NULL,
       method text NOT NULL,
       status_code integer NOT NULL,
       ip_address text,
       user_agent text,
       occurred_at timestamp NOT NULL DEFAULT now()
    )`,
  ];

  for (const stmt of repairs) {
    try {
      await db.execute(sql.raw(stmt));
    } catch (err: any) {
      // Non-fatal: log and continue — some repairs may fail if constraints clash
      logger.warn({ err: err?.message, stmt: stmt.slice(0, 80) }, "Schema repair stmt failed (non-fatal)");
    }
  }
  logger.info("Schema repair complete");
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


  // Run schema repair migrations (idempotent — safe every boot)
  await runSchemaRepair().catch((err) => logger.error({ err }, "Schema repair failed"));

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
});