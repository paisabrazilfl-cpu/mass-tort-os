import { Router } from "express";
import { db, pool, automationWorkflowsTable, automationRunsTable } from "@workspace/db";
import { eq, desc, and, or, isNull, sql } from "drizzle-orm";
import { z } from "zod/v4";
import { authMiddleware, Permission, requirePermission } from "../lib/rbac";
import { badRequest, notFound, forbidden } from "../lib/http-errors";
import { NODE_CATALOG, getNodeDefinition } from "../lib/automations/node-catalog";
import { runWorkflow } from "../lib/automations/executor";
import { callLLM } from "../lib/ai-provider";
import { getAiConstitutionPreamble } from "../lib/ai-constitution";
import {
  recursiveRetry,
  perspectiveCue,
  type AttemptOutcome,
} from "../lib/automations/recursive-retry";
import { logger } from "../lib/logger";


/** Ensure automation_workflows and automation_runs have all required columns. Idempotent. */
async function ensureAutomationSchema(): Promise<void> {
  const stmts = [
    `ALTER TABLE automation_workflows ADD COLUMN IF NOT EXISTS name varchar(200) NOT NULL DEFAULT 'untitled'`,
    `ALTER TABLE automation_workflows ADD COLUMN IF NOT EXISTS description text`,
    `ALTER TABLE automation_workflows ADD COLUMN IF NOT EXISTS graph jsonb NOT NULL DEFAULT '{"nodes":[],"edges":[]}'`,
    `ALTER TABLE automation_workflows ADD COLUMN IF NOT EXISTS enabled boolean NOT NULL DEFAULT false`,
    `ALTER TABLE automation_workflows ADD COLUMN IF NOT EXISTS trigger_type varchar(40) NOT NULL DEFAULT 'manual'`,
    `ALTER TABLE automation_workflows ADD COLUMN IF NOT EXISTS trigger_config jsonb NOT NULL DEFAULT '{}'`,
    `ALTER TABLE automation_workflows ADD COLUMN IF NOT EXISTS tags jsonb NOT NULL DEFAULT '[]'`,
    `ALTER TABLE automation_workflows ADD COLUMN IF NOT EXISTS firm_id integer`,
    `ALTER TABLE automation_workflows ADD COLUMN IF NOT EXISTS created_by_user_id integer`,
    `ALTER TABLE automation_workflows ADD COLUMN IF NOT EXISTS created_at timestamp NOT NULL DEFAULT now()`,
    `ALTER TABLE automation_workflows ADD COLUMN IF NOT EXISTS updated_at timestamp NOT NULL DEFAULT now()`,
    `ALTER TABLE automation_runs ADD COLUMN IF NOT EXISTS workflow_id integer`,
    `ALTER TABLE automation_runs ADD COLUMN IF NOT EXISTS firm_id integer`,
    `ALTER TABLE automation_runs ADD COLUMN IF NOT EXISTS status varchar(20) NOT NULL DEFAULT 'pending'`,
    `ALTER TABLE automation_runs ADD COLUMN IF NOT EXISTS trigger_source varchar(40) NOT NULL DEFAULT 'manual'`,
    `ALTER TABLE automation_runs ADD COLUMN IF NOT EXISTS input jsonb NOT NULL DEFAULT '{}'`,
    `ALTER TABLE automation_runs ADD COLUMN IF NOT EXISTS output jsonb`,
    `ALTER TABLE automation_runs ADD COLUMN IF NOT EXISTS step_log jsonb NOT NULL DEFAULT '[]'`,
    `ALTER TABLE automation_runs ADD COLUMN IF NOT EXISTS error text`,
    `ALTER TABLE automation_runs ADD COLUMN IF NOT EXISTS started_by_user_id integer`,
    `ALTER TABLE automation_runs ADD COLUMN IF NOT EXISTS started_at timestamp NOT NULL DEFAULT now()`,
    `ALTER TABLE automation_runs ADD COLUMN IF NOT EXISTS completed_at timestamp`,
  ];
  for (const stmt of stmts) {
    await db.execute(sql`${sql.raw(stmt)}`).catch(() => {});
  }
}

let _schemaEnsured = false;
async function ensureOnce(): Promise<void> {
  if (_schemaEnsured) return;
  await ensureAutomationSchema();
  _schemaEnsured = true;
}
const router = Router();
router.use(authMiddleware);

/**
 * Tenant predicate: every workflow row carries firm_id, and every read/write
 * MUST be scoped by it. We treat NULL firm_id as a global/system row that's
 * only readable by users in firm_id NULL (none in practice — admins still
 * carry a firm). The executor + run-history endpoints must apply the same
 * predicate so cross-tenant access is impossible even via direct ID lookup.
 */
function firmPredicate(firmId: number | null | undefined) {
  // Null firm_id on a workflow = accessible to all firms (global/system scope)
  if (firmId == null) return isNull(automationWorkflowsTable.firm_id);
  return or(
    eq(automationWorkflowsTable.firm_id, firmId),
    isNull(automationWorkflowsTable.firm_id),
  )!;
}
function runFirmPredicate(firmId: number | null | undefined) {
  if (firmId == null) return isNull(automationRunsTable.firm_id);
  return or(
    eq(automationRunsTable.firm_id, firmId),
    isNull(automationRunsTable.firm_id),
  )!;
}

const graphSchema = z.object({
  nodes: z.array(z.object({
    id: z.string(),
    type: z.string(),
    position: z.object({ x: z.number(), y: z.number() }).optional(),
    data: z.object({
      label: z.string().optional(),
      params: z.record(z.string(), z.any()).optional(),
    }).optional(),
  }).passthrough()).default([]),
  edges: z.array(z.object({
    id: z.string(),
    source: z.string(),
    target: z.string(),
    sourceHandle: z.string().nullish(),
    targetHandle: z.string().nullish(),
  }).passthrough()).default([]),
});

const upsertSchema = z.object({
  name: z.string().min(1).max(200),
  description: z.string().nullish(),
  graph: graphSchema,
  enabled: z.boolean().optional(),
  trigger_type: z.string().max(40).optional(),
  trigger_config: z.record(z.string(), z.any()).optional(),
  tags: z.array(z.string()).optional(),
});

const runBodySchema = z.object({
  input: z.record(z.string(), z.any()).optional(),
});

router.get("/node-catalog", requirePermission(Permission.AUTOMATIONS_VIEW), (_req, res) => {
  res.json({ nodes: NODE_CATALOG });
});


// ── DEBUG: raw table dump (admin only) ──────────────────────────────────
router.get("/debug/tables", requirePermission(Permission.AUTOMATIONS_MANAGE), async (_req, res) => {
  try {
    const tableExists = await pool.query(
      `SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'automation_workflows') AS exists`
    );
    const rowCount = await pool.query(`SELECT COUNT(*) FROM automation_workflows`).catch(() => ({ rows: [{ count: "error" }] }));
    const cols = await pool.query(
      `SELECT column_name, data_type FROM information_schema.columns WHERE table_name = 'automation_workflows' ORDER BY ordinal_position`
    ).catch(() => ({ rows: [] }));
    const rows = await pool.query(`SELECT id, name, firm_id, enabled, trigger_type FROM automation_workflows LIMIT 20`).catch(() => ({ rows: [] }));
    res.json({
      table_exists: tableExists.rows[0]?.exists,
      row_count: rowCount.rows[0]?.count,
      columns: cols.rows,
      rows: rows.rows,
    });
  } catch (err: any) {
    res.status(500).json({ error: err?.message });
  }
});

router.get("/", requirePermission(Permission.AUTOMATIONS_VIEW), async (req, res) => {
  await ensureAutomationSchema();
  const firmId = (req as any).firmId as number | undefined;
  // Use raw SQL via pool to bypass Drizzle schema cache issues with runtime-created columns
  try {
    // Firm filter: include firm-scoped AND null-firm rows.
    // Super-admin users may have firmId=null — treat as no filter.
    let where = "1=1";
    if (firmId != null) {
      where = `(firm_id = ${Number(firmId)} OR firm_id IS NULL)`;
    }
    const raw = await pool.query(
      `SELECT id, name, COALESCE(description, '') AS description, enabled,
       COALESCE(trigger_type, 'manual') AS trigger_type,
       COALESCE(tags, '[]'::jsonb) AS tags,
       updated_at, created_at
       FROM automation_workflows
       WHERE ${where}
       ORDER BY updated_at DESC`
    );
    res.json(raw.rows ?? []);
  } catch (err: any) {
    logger.error({ err: err?.message }, "automations GET failed");
    res.json([]);
  }
});

router.get("/:id", requirePermission(Permission.AUTOMATIONS_VIEW), async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) { badRequest(res, "id must be integer"); return; }
  const firmId = (req as any).firmId as number | undefined;
  try {
    const whereClause = firmId != null
      ? `id = ${id} AND (firm_id = ${Number(firmId)} OR firm_id IS NULL)`
      : `id = ${id}`;
    const raw = await pool.query(
      `SELECT * FROM automation_workflows WHERE ${whereClause} LIMIT 1`
    );
    const row = raw.rows[0];
    if (!row) { notFound(res, "Workflow not found"); return; }
    res.json(row);
  } catch (err: any) {
    logger.error({ err: err?.message }, "automations GET /:id failed");
    notFound(res, "Workflow not found");
  }
});

router.post("/", requirePermission(Permission.AUTOMATIONS_MANAGE), async (req, res) => {
  const parsed = upsertSchema.safeParse(req.body);
  if (!parsed.success) { badRequest(res, "Invalid body", parsed.error.flatten()); return; }
  try { await ensureOnce(); } catch (schemaErr: any) {
    logger.warn({ err: schemaErr?.message }, "ensureOnce failed (non-fatal)");
  }
  const userId = (req as any).user?.id as number | undefined;
  const firmId: number | null = (req as any).user?.firm_id ?? (req as any).firmId ?? null;
  try {
    const qr = await pool.query(
      `INSERT INTO automation_workflows
         (name, description, graph, enabled, trigger_type, trigger_config, tags, firm_id, created_by_user_id)
       VALUES ($1, $2, $3::jsonb, $4, $5, $6::jsonb, $7::jsonb, $8, $9)
       RETURNING *`,
      [
        parsed.data.name,
        parsed.data.description ?? null,
        JSON.stringify(parsed.data.graph ?? { nodes: [], edges: [] }),
        parsed.data.enabled ?? false,
        parsed.data.trigger_type ?? "manual",
        JSON.stringify(parsed.data.trigger_config ?? {}),
        JSON.stringify(parsed.data.tags ?? []),
        firmId ?? null,
        userId ?? null,
      ]
    );
    res.status(201).json(qr.rows[0]);
  } catch (err: any) {
    logger.error({ err: err?.message, firmId, userId }, "automation POST insert failed");
    res.status(500).json({ status: "error", code: "insert_failed", message: err?.message ?? "Insert failed" });
  }
});

router.put("/:id", requirePermission(Permission.AUTOMATIONS_MANAGE), async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) { badRequest(res, "id must be integer"); return; }
  const parsed = upsertSchema.partial().safeParse(req.body);
  if (!parsed.success) { badRequest(res, "Invalid body", parsed.error.flatten()); return; }
  const firmId = (req as any).firmId as number | undefined;
  const [row] = await db.update(automationWorkflowsTable).set({
    ...parsed.data,
    updated_at: new Date(),
  } as any)
    .where(and(eq(automationWorkflowsTable.id, id), firmPredicate(firmId))!)
    .returning();
  if (!row) { notFound(res, "Workflow not found"); return; }
  res.json(row);
});

router.delete("/:id", requirePermission(Permission.AUTOMATIONS_MANAGE), async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) { badRequest(res, "id must be integer"); return; }
  const firmId = (req as any).firmId as number | undefined;
  // Verify ownership before delete.
  const [own] = await db.select({ id: automationWorkflowsTable.id }).from(automationWorkflowsTable)
    .where(and(eq(automationWorkflowsTable.id, id), firmPredicate(firmId))!).limit(1);
  if (!own) { notFound(res, "Workflow not found"); return; }
  await db.delete(automationRunsTable).where(eq(automationRunsTable.workflow_id, id));
  const result = await db.delete(automationWorkflowsTable).where(eq(automationWorkflowsTable.id, id));
  res.json({ deleted: (result as any).rowCount ?? 1 });
});

router.post("/:id/run", requirePermission(Permission.AUTOMATIONS_EXECUTE), async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) { badRequest(res, "id must be integer"); return; }
  const parsed = runBodySchema.safeParse(req.body ?? {});
  if (!parsed.success) { badRequest(res, "Invalid body", parsed.error.flatten()); return; }
  const userId = (req as any).user?.id as number | undefined;
  const firmId = (req as any).firmId as number | undefined;
  // Verify workflow exists — use raw SQL to bypass Drizzle firmPredicate cache issues
  const ownCheck = await pool.query(
    `SELECT id FROM automation_workflows WHERE id = ${id} LIMIT 1`
  ).catch(() => ({ rows: [] as any[] }));
  if (!ownCheck.rows[0]) { notFound(res, "Workflow not found"); return; }
  try {
    const result = await runWorkflow({
      workflowId: id,
      firmId: firmId ?? null,
      input: (parsed.data.input ?? {}) as Record<string, unknown>,
      triggerSource: "manual",
      startedByUserId: userId ?? null,
    });
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ error: err?.message ?? "Run failed" });
  }
});

router.get("/:id/runs", requirePermission(Permission.AUTOMATIONS_VIEW), async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) { badRequest(res, "id must be integer"); return; }
  try {
    const raw = await pool.query(
      `SELECT id, workflow_id, status, trigger_source, started_at, completed_at, error,
       COALESCE(step_log, '[]'::jsonb) AS step_log
       FROM automation_runs WHERE workflow_id = ${id}
       ORDER BY started_at DESC LIMIT 50`
    );
    res.json(raw.rows ?? []);
  } catch (err: any) {
    logger.error({ err: err?.message }, "automations /:id/runs failed");
    res.json([]);
  }
});


router.get("/runs/:runId", requirePermission(Permission.AUTOMATIONS_VIEW), async (req, res) => {
  const runId = Number(req.params.runId);
  if (!Number.isInteger(runId)) { badRequest(res, "runId must be integer"); return; }
  try {
    const raw = await pool.query(
      `SELECT id, workflow_id, status, trigger_source, input, output,
       COALESCE(step_log, '[]'::jsonb) AS steps,
       error, started_at, completed_at, started_by_user_id
       FROM automation_runs WHERE id = ${runId} LIMIT 1`
    );
    const row = raw.rows[0];
    if (!row) { notFound(res, "Run not found"); return; }
    // Normalize: expose step_log as both 'step_log' and 'steps'
    res.json({ ...row, step_log: row.steps, runId: row.id });
  } catch (err: any) {
    logger.error({ err: err?.message }, "automations /runs/:runId failed");
    notFound(res, "Run not found");
  }
});

;