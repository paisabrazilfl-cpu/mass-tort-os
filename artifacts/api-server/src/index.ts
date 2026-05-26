import app from "./app";
import { logger } from "./lib/logger";
import { seedFormConfigurations } from "./lib/form-config-service";
import { seedDefaultFirm, seedSuperAdmin, backfillEmailVerifiedAt } from "./lib/firm-bootstrap";
import { workerLoop } from "./worker";
import { db, automationWorkflowsTable, medicalRecordsRequestsTable, jobQueueTable } from "@workspace/db";
import { eq, and, lt } from "drizzle-orm";
import { auditLog } from "./lib/audit";
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

  // ── MRR SLA follow-up poller ───────────────────────────────────────────────
  // Runs every hour. Finds sent requests whose expected_by window has passed
  // and either re-enqueues a fax (up to MAX_AUTO_RESENDS) or notes they need
  // manual follow-up when the cap is reached.
  const MAX_AUTO_RESENDS = 3;
  const SLA_WINDOW_MS = 14 * 24 * 60 * 60 * 1000; // 14 days

  setInterval(async () => {
    try {
      const overdue = await db
        .select()
        .from(medicalRecordsRequestsTable)
        .where(
          and(
            eq(medicalRecordsRequestsTable.status, "sent"),
            lt(medicalRecordsRequestsTable.expected_by, new Date()),
          ),
        )
        .limit(50);

      for (const req of overdue) {
        try {
          if (req.attempt_count < MAX_AUTO_RESENDS && req.envelope_id != null) {
            // Auto-resend: enqueue a new fax job with the same lead + envelope + fax.
            await db.insert(jobQueueTable).values({
              job_type: "fax_med_records_request",
              payload: {
                lead_id: req.lead_id,
                envelope_id: req.envelope_id,
                override_fax: req.fax_number,
              },
            });
            const newExpectedBy = new Date(Date.now() + SLA_WINDOW_MS);
            await db
              .update(medicalRecordsRequestsTable)
              .set({
                attempt_count: req.attempt_count + 1,
                last_attempt_at: new Date(),
                expected_by: newExpectedBy,
                notes: `Auto-resend #${req.attempt_count + 1} triggered by SLA poller on ${new Date().toISOString().slice(0, 10)}.`,
                updated_at: new Date(),
              })
              .where(eq(medicalRecordsRequestsTable.id, req.id));
            await auditLog("medical_records_request", String(req.id), "sla_auto_resend", {
              lead_id: req.lead_id,
              attempt: req.attempt_count + 1,
              hospital: req.hospital_name,
            });
            logger.info(
              { mrr_id: req.id, lead_id: req.lead_id, attempt: req.attempt_count + 1 },
              "MRR SLA auto-resend enqueued",
            );
          } else {
            // Cap reached or no envelope_id — flag for manual follow-up.
            await db
              .update(medicalRecordsRequestsTable)
              .set({
                notes: `SLA expired after ${req.attempt_count} attempt(s). Manual follow-up required.`,
                updated_at: new Date(),
              })
              .where(eq(medicalRecordsRequestsTable.id, req.id));
            await auditLog("medical_records_request", String(req.id), "sla_manual_followup_required", {
              lead_id: req.lead_id,
              attempts: req.attempt_count,
            });
          }
        } catch (err) {
          logger.error({ err, mrr_id: req.id }, "MRR SLA poller: failed to process request");
        }
      }

      if (overdue.length > 0) {
        logger.info({ count: overdue.length }, "MRR SLA poller: processed overdue requests");
      }
    } catch (err) {
      logger.error({ err }, "MRR SLA poller error");
    }
  }, 60 * 60_000); // every hour

  logger.info("MRR SLA follow-up poller started (60m interval)");
});
