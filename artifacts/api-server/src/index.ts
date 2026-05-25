import app from "./app";
import { logger } from "./lib/logger";
import { seedFormConfigurations } from "./lib/form-config-service";
import { seedDefaultFirm, seedSuperAdmin, seedMasterApiKey, backfillEmailVerifiedAt } from "./lib/firm-bootstrap";
import { workerLoop } from "./worker";
import { db, pool } from "@workspace/db";

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
  // Phase 1: CREATE tables that may not exist in the Render DB
  const creates: string[] = [
    `CREATE TABLE IF NOT EXISTS firms (
      id serial PRIMARY KEY,
      name varchar(255) NOT NULL,
      slug varchar(100) NOT NULL UNIQUE,
      billing_email varchar(255),
      stripe_customer_id varchar(100),
      stripe_subscription_id varchar(100),
      subscription_status varchar(30) NOT NULL DEFAULT 'inactive',
      current_period_end timestamp,
      plan_price_id varchar(100),
      notes text,
      created_at timestamp NOT NULL DEFAULT now(),
      updated_at timestamp NOT NULL DEFAULT now()
    )`,
    `CREATE TABLE IF NOT EXISTS automation_workflows (
      id serial PRIMARY KEY,
      firm_id integer,
      name varchar(200) NOT NULL DEFAULT 'untitled',
      description text,
      graph jsonb NOT NULL DEFAULT '{"nodes":[],"edges":[]}',
      enabled boolean NOT NULL DEFAULT false,
      trigger_type varchar(40) NOT NULL DEFAULT 'manual',
      trigger_config jsonb NOT NULL DEFAULT '{}',
      tags jsonb NOT NULL DEFAULT '[]',
      created_by_user_id integer,
      created_at timestamp NOT NULL DEFAULT now(),
      updated_at timestamp NOT NULL DEFAULT now()
    )`,
    `CREATE INDEX IF NOT EXISTS automation_workflows_firm_idx ON automation_workflows(firm_id, updated_at)`,
    `CREATE INDEX IF NOT EXISTS automation_workflows_trigger_idx ON automation_workflows(trigger_type, enabled)`,
    `CREATE TABLE IF NOT EXISTS automation_runs (
      id serial PRIMARY KEY,
      workflow_id integer NOT NULL,
      firm_id integer,
      status varchar(20) NOT NULL DEFAULT 'pending',
      trigger_source varchar(40) NOT NULL DEFAULT 'manual',
      input jsonb NOT NULL DEFAULT '{}',
      output jsonb,
      step_log jsonb NOT NULL DEFAULT '[]',
      error text,
      started_by_user_id integer,
      started_at timestamp NOT NULL DEFAULT now(),
      completed_at timestamp
    )`,
    `CREATE INDEX IF NOT EXISTS automation_runs_workflow_idx ON automation_runs(workflow_id, started_at)`,
    `CREATE INDEX IF NOT EXISTS automation_runs_firm_status_idx ON automation_runs(firm_id, status, started_at)`,
    `CREATE TABLE IF NOT EXISTS api_keys (
      id serial PRIMARY KEY,
      firm_id integer NOT NULL,
      created_by_user_id integer NOT NULL,
      name text NOT NULL,
      key_hash text NOT NULL UNIQUE,
      key_prefix text NOT NULL,
      scopes text[] NOT NULL DEFAULT '{}',
      last_used_at timestamp,
      revoked_at timestamp,
      created_at timestamp NOT NULL DEFAULT now()
    )`,
    `CREATE INDEX IF NOT EXISTS api_keys_hash_idx ON api_keys(key_hash)`,
    `CREATE INDEX IF NOT EXISTS api_keys_firm_idx ON api_keys(firm_id)`,
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
    `CREATE INDEX IF NOT EXISTS api_key_audit_key_idx ON api_key_audit(api_key_id, occurred_at)`,
    `CREATE INDEX IF NOT EXISTS api_key_audit_occurred_idx ON api_key_audit(occurred_at)`,
    `CREATE TABLE IF NOT EXISTS workflow_settings (
      id serial PRIMARY KEY,
      scope varchar(100) NOT NULL UNIQUE,
      esign_provider_integration_id integer,
      fax_provider_integration_id integer,
      email_provider_integration_id integer,
      sms_provider_integration_id integer,
      voice_provider_integration_id integer,
      llm_default_provider_integration_id integer,
      llm_drafting_provider_integration_id integer,
      default_email_from_name varchar(255),
      default_email_from_address varchar(255),
      default_fax_from_number varchar(50),
      auto_send_on_approval boolean NOT NULL DEFAULT true,
      auto_fax_doctor_on_signed_hipaa boolean NOT NULL DEFAULT true,
      esign_resend_after_days integer NOT NULL DEFAULT 3,
      esign_expire_after_days integer NOT NULL DEFAULT 14,
      max_send_retries integer NOT NULL DEFAULT 3,
      notify_on_failure_email varchar(255),
      med_records_cover_letter_template_id integer,
      metadata jsonb NOT NULL DEFAULT '{}',
      notes text,
      updated_by_user_id integer,
      created_at timestamp NOT NULL DEFAULT now(),
      updated_at timestamp NOT NULL DEFAULT now()
    )`,
    `INSERT INTO workflow_settings(scope) VALUES('global') ON CONFLICT(scope) DO NOTHING`,
    `CREATE TABLE IF NOT EXISTS competitive_intel_advertisers (
      id serial PRIMARY KEY,
      firm_id integer NOT NULL,
      advertiser_id text NOT NULL,
      label text NOT NULL,
      notes text,
      added_by_user_id integer NOT NULL,
      last_fetched_at timestamp,
      last_ad_count integer,
      created_at timestamp NOT NULL DEFAULT now()
    )`,
    `CREATE UNIQUE INDEX IF NOT EXISTS ci_advertisers_firm_adv ON competitive_intel_advertisers(firm_id, advertiser_id)`,
    `CREATE TABLE IF NOT EXISTS competitive_intel_snapshots (
      id serial PRIMARY KEY,
      advertiser_id integer NOT NULL,
      firm_id integer NOT NULL,
      ads jsonb NOT NULL DEFAULT '[]',
      ad_count integer NOT NULL DEFAULT 0,
      fetched_at timestamp NOT NULL DEFAULT now()
    )`,
    `CREATE TABLE IF NOT EXISTS self_heal_sessions (
      id serial PRIMARY KEY,
      firm_id integer,
      prompt text NOT NULL,
      status varchar(30) NOT NULL DEFAULT 'pending',
      plan text,
      pr_url text,
      created_by_user_id integer,
      created_at timestamp NOT NULL DEFAULT now(),
      updated_at timestamp NOT NULL DEFAULT now()
    )`,
    // Magic-link (passwordless email) sign-in tokens. Only the SHA-256 hash
    // of the token is stored; single-use (consumed_at) and short-lived
    // (expires_at — 15 min). See lib/magic-link.ts + routes/auth.ts.
    `CREATE TABLE IF NOT EXISTS auth_magic_links (
      id serial PRIMARY KEY,
      user_id integer NOT NULL,
      token_hash text NOT NULL,
      expires_at timestamp NOT NULL,
      consumed_at timestamp,
      created_ip varchar(45),
      created_at timestamp NOT NULL DEFAULT now()
    )`,
    `CREATE INDEX IF NOT EXISTS auth_magic_links_token_hash_idx ON auth_magic_links(token_hash)`,
    // Passkey (WebAuthn) sign-in: one row per enrolled credential (public
    // key + signature counter — the private key never leaves the device),
    // plus a short-lived single-use challenge store. See lib/passkey.ts.
    `CREATE TABLE IF NOT EXISTS webauthn_credentials (
      id serial PRIMARY KEY,
      user_id integer NOT NULL,
      credential_id text NOT NULL UNIQUE,
      public_key text NOT NULL,
      counter bigint NOT NULL DEFAULT 0,
      transports text,
      device_name text,
      created_at timestamp NOT NULL DEFAULT now(),
      last_used_at timestamp
    )`,
    `CREATE INDEX IF NOT EXISTS webauthn_credentials_user_idx ON webauthn_credentials(user_id)`,
    `CREATE TABLE IF NOT EXISTS webauthn_challenges (
      id text PRIMARY KEY,
      challenge text NOT NULL,
      purpose varchar(20) NOT NULL,
      user_id integer,
      expires_at timestamp NOT NULL,
      created_at timestamp NOT NULL DEFAULT now()
    )`,
    // SMS one-time-code sign-in: 6-digit codes stored only as a SHA-256
    // hash, single-use, 10-min TTL, attempt-capped. See lib/sms-auth.ts.
    `CREATE TABLE IF NOT EXISTS auth_otp_codes (
      id serial PRIMARY KEY,
      user_id integer NOT NULL,
      purpose varchar(20) NOT NULL,
      code_hash text NOT NULL,
      phone text NOT NULL,
      attempts integer NOT NULL DEFAULT 0,
      expires_at timestamp NOT NULL,
      consumed_at timestamp,
      created_at timestamp NOT NULL DEFAULT now()
    )`,
    `CREATE INDEX IF NOT EXISTS auth_otp_codes_user_purpose_idx ON auth_otp_codes(user_id, purpose, created_at)`,
  ];

  // Phase 2: ALTER TABLE to add any columns still missing
  const alters: string[] = [
    `ALTER TABLE automation_workflows ADD COLUMN IF NOT EXISTS tags jsonb NOT NULL DEFAULT '[]'`,
    `ALTER TABLE automation_workflows ADD COLUMN IF NOT EXISTS trigger_config jsonb NOT NULL DEFAULT '{}'`,
    `ALTER TABLE automation_workflows ADD COLUMN IF NOT EXISTS trigger_type varchar(40) NOT NULL DEFAULT 'manual'`,
    `ALTER TABLE automation_workflows ADD COLUMN IF NOT EXISTS description text`,
    `ALTER TABLE automation_workflows ADD COLUMN IF NOT EXISTS firm_id integer`,
    `ALTER TABLE automation_workflows ADD COLUMN IF NOT EXISTS created_by_user_id integer`,
    `ALTER TABLE automation_runs ADD COLUMN IF NOT EXISTS trigger_source varchar(40) NOT NULL DEFAULT 'manual'`,
    `ALTER TABLE automation_runs ADD COLUMN IF NOT EXISTS step_log jsonb NOT NULL DEFAULT '[]'`,
    `ALTER TABLE automation_runs ADD COLUMN IF NOT EXISTS output jsonb`,
    `ALTER TABLE automation_runs ADD COLUMN IF NOT EXISTS firm_id integer`,
    `ALTER TABLE automation_runs ADD COLUMN IF NOT EXISTS started_by_user_id integer`,
    `ALTER TABLE automation_runs ADD COLUMN IF NOT EXISTS completed_at timestamp`,
    `ALTER TABLE api_keys DROP COLUMN IF EXISTS revoked`,
    `ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS revoked_at timestamp`,
    // Inbound-fax intake (Stage 4): provider-namespaced external fax id +
    // a unique index so a re-delivered inbound webhook can never duplicate
    // a claimant's medical-record row, even under concurrent retries.
    `ALTER TABLE fax_results ADD COLUMN IF NOT EXISTS external_fax_id text`,
    `CREATE UNIQUE INDEX IF NOT EXISTS fax_results_external_fax_id_unique ON fax_results(external_fax_id)`,
    // integrations dedupe: keep the most recent row per (firm_id, provider)
    // pair, drop the rest. The POST /api/integrations route used to allow
    // multiple rows for the same provider in the same firm, which compounded
    // every time an operator clicked Save — producing rows like "OpenRouter
    // x21" in the Integrations Hub. Idempotent: after the first run there's
    // nothing to delete on subsequent boots.
    `DELETE FROM integrations a USING integrations b
       WHERE a.firm_id IS NOT DISTINCT FROM b.firm_id
         AND a.provider = b.provider
         AND a.id < b.id`,
    // Enforce the post-dedupe invariant at the DB level so future double-saves
    // collide with a CONFLICT we can detect and turn into an upsert.
    `CREATE UNIQUE INDEX IF NOT EXISTS integrations_firm_provider_unique
       ON integrations(firm_id, provider)
       WHERE firm_id IS NOT NULL`,
    // SMS-code sign-in (Stage: passwordless). A user's verified phone lives
    // on the user row; phone_verified_at NULL until the enrollment code is
    // confirmed. See lib/sms-auth.ts + routes/auth.ts.
    `ALTER TABLE mtos_users ADD COLUMN IF NOT EXISTS phone text`,
    `ALTER TABLE mtos_users ADD COLUMN IF NOT EXISTS phone_verified_at timestamp`,
    // Capacity flattening: MTOS runs a single privileged tier. Promote every
    // existing non-admin account to admin so the stored role matches the
    // capacity it now has (see rbac.ts → elevateRole). super_admin is left
    // intact. Idempotent — after the first boot nothing matches.
    `UPDATE mtos_users SET role = 'admin', updated_at = NOW()
       WHERE role NOT IN ('admin', 'super_admin')`,
    // Admin PIN gate (super_admin sudo-mode). admin_pin_hash NULL means
    // the account is still on the stock PIN 1234 — unlock then forces a
    // change. admin_pin_changed_at records when the stock value was rotated.
    `ALTER TABLE mtos_users ADD COLUMN IF NOT EXISTS admin_pin_hash text`,
    `ALTER TABLE mtos_users ADD COLUMN IF NOT EXISTS admin_pin_changed_at timestamp`,
  ];

  for (const stmt of [...creates, ...alters]) {
    try { await pool.query(stmt); } catch { /* IF NOT EXISTS — safe to ignore */ }
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

  // Master API key bootstrap — no-op unless MTOS_MASTER_API_KEY is set.
  // Runs AFTER seedSuperAdmin so the owning super-admin user exists. When
  // set, registers the value as a wildcard-scope ("*") API key so that
  // `Authorization: Bearer <MTOS_MASTER_API_KEY>` has full programmatic
  // access to every API route.
  try {
    const masterResult = await seedMasterApiKey();
    if (!masterResult.skipped) {
      logger.info(masterResult, "Master API key seed complete");
    }
  } catch (e) {
    logger.error({ err: e }, "Master API key seed failed on boot");
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

    // Schedule poller — fires trigger.schedule every 60s for cron-based workflows
    (async () => {
      const { dispatchTrigger } = await import("./lib/automations/dispatch");
      setInterval(() => {
        const now = new Date();
        dispatchTrigger("trigger.schedule", {
          input: { fired_at: now.toISOString(), minute: now.getMinutes(), hour: now.getHours() },
          firmId: "any" as any,
          source: "schedule_poller",
        }).catch((err) => {
          logger.error({ err }, "schedule_poller trigger failed");
        });
      }, 60_000);
      logger.info("Schedule poller started (60s interval)");

    // Start CI poller (recursive: IDLE→POLL→DETECT→TEST→AI_REVIEW→GATE→COMPLETE/RETRY/ABORT)
    const { startCiPoller } = await import("./lib/ci-poller");
    startCiPoller();
    })().catch((err) => logger.error({ err }, "Schedule poller failed to start"));

  } else {
    logger.info("In-process worker disabled (dev mode — separate worker workflow handles jobs)");
  }
});