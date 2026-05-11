

-- ─── AUTOMATION ENGINE ────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "automation_workflows" (
  "id" serial PRIMARY KEY,
  "firm_id" integer,
  "name" varchar(200) NOT NULL DEFAULT 'untitled',
  "description" text,
  "graph" jsonb NOT NULL DEFAULT '{"nodes":[],"edges":[]}',
  "enabled" boolean NOT NULL DEFAULT false,
  "trigger_type" varchar(40) NOT NULL DEFAULT 'manual',
  "trigger_config" jsonb NOT NULL DEFAULT '{}',
  "tags" jsonb NOT NULL DEFAULT '[]',
  "created_by_user_id" integer,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "automation_workflows_firm_idx" ON "automation_workflows"("firm_id","updated_at");
CREATE INDEX IF NOT EXISTS "automation_workflows_trigger_idx" ON "automation_workflows"("trigger_type","enabled");

CREATE TABLE IF NOT EXISTS "automation_runs" (
  "id" serial PRIMARY KEY,
  "workflow_id" integer NOT NULL,
  "firm_id" integer,
  "status" varchar(20) NOT NULL DEFAULT 'pending',
  "trigger_source" varchar(40) NOT NULL DEFAULT 'manual',
  "input" jsonb NOT NULL DEFAULT '{}',
  "output" jsonb,
  "step_log" jsonb NOT NULL DEFAULT '[]',
  "error" text,
  "started_by_user_id" integer,
  "started_at" timestamp NOT NULL DEFAULT now(),
  "completed_at" timestamp
);
CREATE INDEX IF NOT EXISTS "automation_runs_workflow_idx" ON "automation_runs"("workflow_id","started_at");
CREATE INDEX IF NOT EXISTS "automation_runs_firm_status_idx" ON "automation_runs"("firm_id","status","started_at");
