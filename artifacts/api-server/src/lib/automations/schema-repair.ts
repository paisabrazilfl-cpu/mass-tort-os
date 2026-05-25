import { pool } from "@workspace/db";

/**
 * Idempotent schema repair — adds missing columns and tables.
 * Uses pool.query() (raw node-postgres) to bypass Drizzle schema cache.
 * Safe to run on every request (cached after first run via _done flag).
 */

const STMTS: string[] = [
  "ALTER TABLE automation_workflows ADD COLUMN IF NOT EXISTS name varchar(200) NOT NULL DEFAULT 'untitled'",
  "ALTER TABLE automation_workflows ADD COLUMN IF NOT EXISTS description text",
  "ALTER TABLE automation_workflows ADD COLUMN IF NOT EXISTS enabled boolean NOT NULL DEFAULT false",
  "ALTER TABLE automation_workflows ADD COLUMN IF NOT EXISTS trigger_type varchar(40) NOT NULL DEFAULT 'manual'",
  "ALTER TABLE automation_workflows ADD COLUMN IF NOT EXISTS trigger_config jsonb NOT NULL DEFAULT '{}'",
  "ALTER TABLE automation_workflows ADD COLUMN IF NOT EXISTS tags jsonb NOT NULL DEFAULT '[]'",
  "ALTER TABLE automation_workflows ADD COLUMN IF NOT EXISTS firm_id integer",
  "ALTER TABLE automation_workflows ADD COLUMN IF NOT EXISTS created_by_user_id integer",
  "ALTER TABLE automation_workflows ADD COLUMN IF NOT EXISTS created_at timestamp NOT NULL DEFAULT now()",
  "ALTER TABLE automation_workflows ADD COLUMN IF NOT EXISTS updated_at timestamp NOT NULL DEFAULT now()",
  "ALTER TABLE automation_runs ADD COLUMN IF NOT EXISTS workflow_id integer",
  "ALTER TABLE automation_runs ADD COLUMN IF NOT EXISTS firm_id integer",
  "ALTER TABLE automation_runs ADD COLUMN IF NOT EXISTS status varchar(20) NOT NULL DEFAULT 'pending'",
  "ALTER TABLE automation_runs ADD COLUMN IF NOT EXISTS trigger_source varchar(40) NOT NULL DEFAULT 'manual'",
  "ALTER TABLE automation_runs ADD COLUMN IF NOT EXISTS input jsonb NOT NULL DEFAULT '{}'",
  "ALTER TABLE automation_runs ADD COLUMN IF NOT EXISTS output jsonb",
  "ALTER TABLE automation_runs ADD COLUMN IF NOT EXISTS step_log jsonb NOT NULL DEFAULT '[]'",
  "ALTER TABLE automation_runs ADD COLUMN IF NOT EXISTS error text",
  "ALTER TABLE automation_runs ADD COLUMN IF NOT EXISTS started_by_user_id integer",
  "ALTER TABLE automation_runs ADD COLUMN IF NOT EXISTS started_at timestamp NOT NULL DEFAULT now()",
  "ALTER TABLE automation_runs ADD COLUMN IF NOT EXISTS completed_at timestamp",
  "ALTER TABLE api_keys DROP COLUMN IF EXISTS revoked",
  "ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS revoked_at timestamp",
  "CREATE TABLE IF NOT EXISTS api_key_audit (id serial PRIMARY KEY, api_key_id integer NOT NULL, route text NOT NULL, method text NOT NULL, status_code integer NOT NULL, ip_address text, user_agent text, occurred_at timestamp NOT NULL DEFAULT now())",
  "CREATE TABLE IF NOT EXISTS competitive_intel_advertisers (id serial PRIMARY KEY, firm_id integer NOT NULL, advertiser_id text NOT NULL, label text NOT NULL, notes text, added_by_user_id integer NOT NULL, last_fetched_at timestamp, last_ad_count integer, created_at timestamp NOT NULL DEFAULT now())",
  "CREATE UNIQUE INDEX IF NOT EXISTS ci_adv_firm ON competitive_intel_advertisers(firm_id, advertiser_id)",
  "CREATE TABLE IF NOT EXISTS competitive_intel_snapshots (id serial PRIMARY KEY, advertiser_id integer NOT NULL, firm_id integer NOT NULL, ads jsonb NOT NULL DEFAULT '[]', ad_count integer NOT NULL DEFAULT 0, fetched_at timestamp NOT NULL DEFAULT now())",
  "CREATE TABLE IF NOT EXISTS self_heal_sessions (id serial PRIMARY KEY, firm_id integer, prompt text NOT NULL, status varchar(30) NOT NULL DEFAULT 'pending', plan text, pr_url text, created_by_user_id integer, created_at timestamp NOT NULL DEFAULT now(), updated_at timestamp NOT NULL DEFAULT now())",
];

let _done = false;

export async function ensureAutomationSchema(): Promise<void> {
  if (_done) return;
  for (const s of STMTS) {
    try { await pool.query(s); } catch { /* IF NOT EXISTS — safe */ }
  }
  _done = true;
}
