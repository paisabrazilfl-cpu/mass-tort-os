import app from "./app";
import { logger } from "./lib/logger";
import { seedFormConfigurations } from "./lib/form-config-service";
import { workerLoop } from "./worker";

// =============================================================================
// Boot env validation (Task #10).
//
// The single biggest "silent" RBAC vulnerability we've shipped historically is
// booting production with a dev-shaped environment — a missing SESSION_SECRET
// lets express-session fall back to a generated key on every restart (logging
// every user out), and a missing ENCRYPTION_KEY means the integrations
// credential store can't decrypt tokens. We fail fast on boot so the
// container restart loop alerts ops instead of running half-broken.
//
// `development` is the only mode allowed to skip these — it mirrors the
// dev-gate in lib/rbac.ts so the two cannot drift apart.
// =============================================================================
const NODE_ENV = process.env["NODE_ENV"] ?? "development";
const IS_DEV = NODE_ENV === "development";

const REQUIRED_ENV_PROD = ["DATABASE_URL", "SESSION_SECRET", "ENCRYPTION_KEY"] as const;
if (!IS_DEV) {
  const missing = REQUIRED_ENV_PROD.filter((k) => !process.env[k] || String(process.env[k]).trim() === "");
  if (missing.length > 0) {
    logger.fatal({ missing, NODE_ENV }, "FATAL: required environment variables missing for non-dev boot");
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

  // Startup banner (Task #10): a single log line that ops can grep for to
  // confirm which security posture the process actually booted with.
  logger.info(
    {
      port,
      node_env: NODE_ENV,
      dev_mode: IS_DEV,
      has_session_secret: Boolean(process.env["SESSION_SECRET"]),
      has_encryption_key: Boolean(process.env["ENCRYPTION_KEY"]),
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
