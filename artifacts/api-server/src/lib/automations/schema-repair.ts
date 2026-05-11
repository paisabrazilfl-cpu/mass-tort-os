import { pool } from "@workspace/db";

/**
 * Idempotent schema repair — adds columns to automation_workflows and
 * automation_runs that may be missing if the table was created before
 * these columns were added to the Drizzle schema. Uses pool.query()
 * (raw node-postgres) because db.execute() requires the column to already
 * be known to Drizzle at compile time.
 *
 * Run before any INSERT/SELECT against these tables.
 */

const REPAIR_STMTS: string[] = [
  // automation_workflows
  "ALTER TABLE automation_workflows ADD COLUMN IF NOT EXISTS name varchar(200) NOT NULL DEFAULT 'untitled'",
  "ALTER TABLE automation_workflows ADD COLUMN IF NOT EXISTS description text",
  "ALTER TABLE automation_workflows ADD COLUMN IF NOT EXISTS graph jsonb NOT NULL DEFAULT '{\"nodes\":[],\"edges\":[]}'",
  "ALTER TABLE automation_workflows ADD COLUMN IF NOT EXISTS enabled boolean NOT NULL DEFAULT false",
  "ALTER TABLE automation_workflows ADD COLUMN IF NOT EXISTS trigger_type varchar(40) NOT NULL DEFAULT 'manual'",
  "ALTER TABLE automation_workflows ADD COLUMN IF NOT EXISTS trigger_config jsonb NOT NULL DEFAULT '{}'",
  "ALTER TABLE automation_workflows ADD COLUMN IF NOT EXISTS tags jsonb NOT NULL DEFAULT '[]'",
  "ALTER TABLE automation_workflows ADD COLUMN IF NOT EXISTS firm_id integer",
  "ALTER TABLE automation_workflows ADD COLUMN IF NOT EXISTS created_by_user_id integer",
  "ALTER TABLE automation_workflows ADD COLUMN IF NOT EXISTS created_at timestamp NOT NULL DEFAULT now()",
  "ALTER TABLE automation_workflows ADD COLUMN IF NOT EXISTS updated_at timestamp NOT NULL DEFAULT now()",
  // automation_runs
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
];

let repairDone = false;

export async function ensureAutomationSchema(): Promise<void> {
  if (repairDone) return;
  for (const stmt of REPAIR_STMTS) {
    try { await pool.query(stmt); } catch { /* IF NOT EXISTS — safe to ignore */ }
  }
  repairDone = true;
}
