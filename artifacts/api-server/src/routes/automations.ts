import { Router } from "express";
import { db, pool, automationWorkflowsTable, automationRunsTable } from "@workspace/db";
import { eq, desc, and, or, isNull, sql } from "drizzle-orm";
import { z } from "zod/v4";
import { authMiddleware, Permission, requirePermission } from "../lib/rbac";
import { requireFirmId } from "../lib/firm-scope";
import { badRequest, notFound } from "../lib/http-errors";
import { NODE_CATALOG } from "../lib/automations/node-catalog";
import { runWorkflow } from "../lib/automations/executor";
import { callLLM } from "../lib/ai-provider";
import { getAiConstitutionPreamble } from "../lib/ai-constitution";
import { recursiveRetry, perspectiveCue, type AttemptOutcome } from "../lib/automations/recursive-retry";
import { logger } from "../lib/logger";

// BUILD_VERSION: v20260511-clean
// Idempotent schema repair — runs at first request, then caches.
let _schemaDone = false;
async function repairSchema(): Promise<void> {
  if (_schemaDone) return;
  const stmts: string[] = [
    "ALTER TABLE automation_workflows ADD COLUMN IF NOT EXISTS description text",
    "ALTER TABLE automation_workflows ADD COLUMN IF NOT EXISTS enabled boolean NOT NULL DEFAULT false",
    "ALTER TABLE automation_workflows ADD COLUMN IF NOT EXISTS trigger_type varchar(40) NOT NULL DEFAULT 'manual'",
    "ALTER TABLE automation_workflows ADD COLUMN IF NOT EXISTS trigger_config jsonb NOT NULL DEFAULT '{}'",
    "ALTER TABLE automation_workflows ADD COLUMN IF NOT EXISTS tags jsonb NOT NULL DEFAULT '[]'",
    "ALTER TABLE automation_workflows ADD COLUMN IF NOT EXISTS firm_id integer",
    "ALTER TABLE automation_workflows ADD COLUMN IF NOT EXISTS created_by_user_id integer",
    "ALTER TABLE automation_workflows ADD COLUMN IF NOT EXISTS created_at timestamp NOT NULL DEFAULT now()",
    "ALTER TABLE automation_workflows ADD COLUMN IF NOT EXISTS updated_at timestamp NOT NULL DEFAULT now()",
    "ALTER TABLE automation_runs ADD COLUMN IF NOT EXISTS trigger_source varchar(40) NOT NULL DEFAULT 'manual'",
    "ALTER TABLE automation_runs ADD COLUMN IF NOT EXISTS input jsonb NOT NULL DEFAULT '{}'",
    "ALTER TABLE automation_runs ADD COLUMN IF NOT EXISTS output jsonb",
    "ALTER TABLE automation_runs ADD COLUMN IF NOT EXISTS step_log jsonb NOT NULL DEFAULT '[]'",
    "ALTER TABLE automation_runs ADD COLUMN IF NOT EXISTS error text",
    "ALTER TABLE automation_runs ADD COLUMN IF NOT EXISTS firm_id integer",
    "ALTER TABLE automation_runs ADD COLUMN IF NOT EXISTS started_by_user_id integer",
    "ALTER TABLE automation_runs ADD COLUMN IF NOT EXISTS started_at timestamp NOT NULL DEFAULT now()",
    "ALTER TABLE automation_runs ADD COLUMN IF NOT EXISTS completed_at timestamp",
    "CREATE TABLE IF NOT EXISTS competitive_intel_advertisers (id serial PRIMARY KEY, firm_id integer NOT NULL, advertiser_id text NOT NULL, label text NOT NULL, notes text, added_by_user_id integer NOT NULL, last_fetched_at timestamp, last_ad_count integer, created_at timestamp NOT NULL DEFAULT now())",
    "CREATE UNIQUE INDEX IF NOT EXISTS ci_adv_firm ON competitive_intel_advertisers(firm_id, advertiser_id)",
    "CREATE TABLE IF NOT EXISTS self_heal_sessions (id serial PRIMARY KEY, firm_id integer, prompt text NOT NULL, status varchar(30) NOT NULL DEFAULT 'pending', plan text, pr_url text, created_by_user_id integer, created_at timestamp NOT NULL DEFAULT now(), updated_at timestamp NOT NULL DEFAULT now())",
  ];
  for (const s of stmts) {
    try { await pool.query(s); } catch { /* IF NOT EXISTS — safe */ }
  }
  _schemaDone = true;
}

const router = Router();
router.use(authMiddleware);

// Firm scope helper — null firm_id = accessible to all firms (global)
function fWhere(firmId: number | null | undefined): string {
  if (firmId == null) return "1=1";
  return "firm_id = " + Number(firmId) + " OR firm_id IS NULL";
}

const graphSchema = z.object({
  nodes: z.array(z.object({
    id: z.string(),
    type: z.string(),
    position: z.object({ x: z.number(), y: z.number() }).optional(),
    data: z.object({ label: z.string().optional(), params: z.record(z.string(), z.any()).optional() }).optional(),
  }).passthrough()).default([]),
  edges: z.array(z.object({
    id: z.string(), source: z.string(), target: z.string(),
    sourceHandle: z.string().nullish(), targetHandle: z.string().nullish(),
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

const runBodySchema = z.object({ input: z.record(z.string(), z.any()).optional() });

const assistGraphSchema = graphSchema;

function buildCatalogSummary(): string {
  const cats = Array.from(new Set(NODE_CATALOG.map(n => n.category))).sort();
  return cats.map(cat => {
    const nodes = NODE_CATALOG.filter(n => n.category === cat);
    return `[${cat}]\n` + nodes.map(n => {
      const out = Array.isArray(n.outputs) ? ` [${n.outputs.join('|')}]` : "";
      return `  - ${n.type}${out}: ${n.description}`;
    }).join("\n");
  }).join("\n\n");
}

function validateAssistGraph(graph: z.infer<typeof assistGraphSchema>): { issues: string[]; warnings: string[] } {
  const issues: string[] = [];
  const warnings: string[] = [];
  const nodeIds = new Set(graph.nodes.map(n => n.id));

  for (const node of graph.nodes) {
    const def = NODE_CATALOG.find(n => n.type === node.type);
    if (!def) {
      issues.push(`Unknown node type: ${node.type}`);
      continue;
    }
  }

  for (const edge of graph.edges) {
    if (!nodeIds.has(edge.source)) issues.push(`Edge source not found: ${edge.source}`);
    if (!nodeIds.has(edge.target)) issues.push(`Edge target not found: ${edge.target}`);

    const sourceNode = graph.nodes.find(n => n.id === edge.source);
    if (sourceNode) {
      const def = NODE_CATALOG.find(n => n.type === sourceNode.type);
      if (def && Array.isArray(def.outputs) && edge.sourceHandle && !def.outputs.includes(edge.sourceHandle)) {
        issues.push(`Invalid output handle "${edge.sourceHandle}" for node type ${sourceNode.type}`);
      }
    }
  }

  return { issues, warnings };
}

export const __assistInternals = {
  validateAssistGraph,
  buildCatalogSummary,
  assistGraphSchema
};

// ── Node catalog ─────────────────────────────────────────────────────────────
router.get("/node-catalog", requirePermission(Permission.AUTOMATIONS_VIEW), (_req, res) => {
  res.json({ nodes: NODE_CATALOG });
});

// ── Debug / one-shot migration ───────────────────────────────────────────────
router.get("/debug/tables", requirePermission(Permission.AUTOMATIONS_MANAGE), async (req, res) => {
  try {
    await repairSchema();
    const [wf, ar, ci, sh] = await Promise.all([
      pool.query("SELECT COUNT(*) FROM automation_workflows"),
      pool.query("SELECT COUNT(*) FROM automation_runs").catch((err) => {
        logger.error({ err }, "debug/tables: failed to query automation_runs");
        return { rows: [{ count: "error" }] };
      }),
      pool.query("SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name='competitive_intel_advertisers') AS e"),
      pool.query("SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name='self_heal_sessions') AS e"),
    ]);
    res.json({
      automation_workflows: { count: wf.rows[0]?.count },
      automation_runs: { count: ar.rows[0]?.count },
      competitive_intel_advertisers: { exists: ci.rows[0]?.e },
      self_heal_sessions: { exists: sh.rows[0]?.e },
      schema_done: _schemaDone,
    });
  } catch (err: any) {
    res.status(500).json({ error: err?.message });
  }
});

// ── List workflows ────────────────────────────────────────────────────────────


router.get("/", requirePermission(Permission.AUTOMATIONS_VIEW), async (req, res) => {
  await repairSchema();
  const firmId = requireFirmId(req);
  try {
    const raw = await pool.query(
      "SELECT id, name, COALESCE(description,'') AS description, enabled, COALESCE(trigger_type,'manual') AS trigger_type, COALESCE(tags,'[]'::jsonb) AS tags, updated_at, created_at FROM automation_workflows WHERE firm_id = $1 OR firm_id IS NULL ORDER BY updated_at DESC",
      [firmId]
    );
    res.json(raw.rows ?? []);
  } catch (err: any) {
    logger.error({ err: err?.message }, "automations GET / failed");
    res.json([]);
  }
});

// ── Get single workflow ───────────────────────────────────────────────────────
router.get("/:id", requirePermission(Permission.AUTOMATIONS_VIEW), async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) { badRequest(res, "id must be integer"); return; }
  const firmId = requireFirmId(req);
  try {
    const raw = await pool.query(
      "SELECT * FROM automation_workflows WHERE id = $1 AND (firm_id = $2 OR firm_id IS NULL) LIMIT 1",
      [id, firmId]
    );
    if (!raw.rows[0]) { notFound(res, "Workflow not found"); return; }
    res.json(raw.rows[0]);
  } catch (err: any) {
    notFound(res, "Workflow not found");
  }
});

// ── Create workflow ───────────────────────────────────────────────────────────
router.post("/", requirePermission(Permission.AUTOMATIONS_MANAGE), async (req, res) => {
  const parsed = upsertSchema.safeParse(req.body);
  if (!parsed.success) { badRequest(res, "Invalid body", parsed.error.flatten()); return; }
  await repairSchema();
  const userId = req.user?.id;
  const firmId = requireFirmId(req);
  const [row] = await db.insert(automationWorkflowsTable).values({
    name: parsed.data.name,
    description: parsed.data.description ?? null,
    graph: parsed.data.graph,
    enabled: parsed.data.enabled ?? false,
    trigger_type: parsed.data.trigger_type ?? "manual",
    trigger_config: parsed.data.trigger_config ?? {},
    tags: parsed.data.tags ?? [],
    firm_id: firmId ?? null,
    created_by_user_id: userId ?? null,
  } as any).returning();
  res.status(201).json(row);
});

// ── Update workflow ───────────────────────────────────────────────────────────
router.put("/:id", requirePermission(Permission.AUTOMATIONS_MANAGE), async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) { badRequest(res, "id must be integer"); return; }
  const parsed = upsertSchema.partial().safeParse(req.body);
  if (!parsed.success) { badRequest(res, "Invalid body", parsed.error.flatten()); return; }
  const firmId = requireFirmId(req);
  const [row] = await db.update(automationWorkflowsTable)
    .set({ ...parsed.data, updated_at: new Date() } as any)
    .where(and(eq(automationWorkflowsTable.id, id), or(eq(automationWorkflowsTable.firm_id, firmId), isNull(automationWorkflowsTable.firm_id))!)!)
    .returning();
  if (!row) { notFound(res, "Workflow not found"); return; }
  res.json(row);
});

// ── Delete workflow ───────────────────────────────────────────────────────────
router.delete("/:id", requirePermission(Permission.AUTOMATIONS_MANAGE), async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) { badRequest(res, "id must be integer"); return; }
  const firmId = requireFirmId(req);
  const r = await pool.query(
    "DELETE FROM automation_workflows WHERE id = $1 AND (firm_id = $2 OR firm_id IS NULL)",
    [id, firmId]
  ).catch((err) => {
    logger.error({ err, id }, "DELETE /:id: failed to delete workflow");
    return { rowCount: 0 };
  });
  res.json({ deleted: (r as any).rowCount ?? 0 });
});

// ── Run workflow ──────────────────────────────────────────────────────────────
router.post("/:id/run", requirePermission(Permission.AUTOMATIONS_EXECUTE), async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) { badRequest(res, "id must be integer"); return; }
  const parsed = runBodySchema.safeParse(req.body ?? {});
  if (!parsed.success) { badRequest(res, "Invalid body", parsed.error.flatten()); return; }
  const userId = req.user?.id;
  const firmId = requireFirmId(req);
  const check = await pool.query(
    "SELECT id, firm_id FROM automation_workflows WHERE id = $1 AND (firm_id = $2 OR firm_id IS NULL) LIMIT 1",
    [id, firmId]
  ).catch((err) => {
    logger.error({ err, id }, "run: failed to check workflow");
    return { rows: [] };
  });
  if (!check.rows[0]) { notFound(res, "Workflow not found"); return; }
  try {
    const result = await runWorkflow({
      workflowId: id,
      firmId: firmId,
      input: (parsed.data.input ?? {}) as Record<string, unknown>,
      triggerSource: "manual",
      startedByUserId: userId ?? null,
    });
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ error: err?.message ?? "Run failed" });
  }
});

// ── Run history for workflow ──────────────────────────────────────────────────
router.get("/:id/runs", requirePermission(Permission.AUTOMATIONS_VIEW), async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) { badRequest(res, "id must be integer"); return; }
  const firmId = requireFirmId(req);
  try {
    const raw = await pool.query(
      "SELECT id, workflow_id, status, COALESCE(trigger_source,'manual') AS trigger_source, started_at, completed_at, error FROM automation_runs WHERE workflow_id = $1 AND firm_id = $2 ORDER BY started_at DESC LIMIT 50",
      [id, firmId]
    );
    res.json(raw.rows ?? []);
  } catch (err: any) {
    logger.error({ err: err?.message }, "automations /:id/runs failed");
    res.json([]);
  }
});

// ── Single run detail ─────────────────────────────────────────────────────────
router.get("/runs/:runId", requirePermission(Permission.AUTOMATIONS_VIEW), async (req, res) => {
  const runId = Number(req.params.runId);
  if (!Number.isInteger(runId)) { badRequest(res, "runId must be integer"); return; }
  const firmId = requireFirmId(req);
  try {
    const raw = await pool.query("SELECT * FROM automation_runs WHERE id = $1 AND firm_id = $2 LIMIT 1", [runId, firmId]);
    const row = raw.rows[0];
    if (!row) { notFound(res, "Run not found"); return; }
    const sl = row.step_log ?? [];
    res.json({ ...row, steps: sl, runId: row.id });
  } catch (err: any) {
    logger.error({ err: err?.message }, "automations /runs/:runId failed");
    notFound(res, "Run not found");
  }
});

// ── AI Assist ─────────────────────────────────────────────────────────────────
router.post("/assist", requirePermission(Permission.AUTOMATIONS_MANAGE), async (req, res) => {
  const assistSchema = z.object({
    prompt: z.string().min(1),
    currentGraph: graphSchema.optional(),
    mode: z.enum(["replace", "patch", "describe"]).default("replace"),
  });
  const parsed = assistSchema.safeParse(req.body);
  if (!parsed.success) { badRequest(res, "Invalid assist request", parsed.error.flatten()); return; }

  const systemPrompt = [
    await getAiConstitutionPreamble(),
    "You are an automation workflow builder for the MTOS mass-tort CRM.",
    "Output ONLY valid JSON with shape: { graph: { nodes: [...], edges: [...] } }",
    "Available node types: " + JSON.stringify(NODE_CATALOG.map((n: any) => n.type)),
  ].join("\n");

  const attempt = async (ctx: any): Promise<AttemptOutcome<{ graph: z.infer<typeof graphSchema> }>> => {
    const cue = perspectiveCue(ctx.perspectiveIndex);
    const userMsg = [
      parsed.data.prompt,
      ctx.previousError ? "Previous attempt failed: " + ctx.previousError.errorMessage + ". " + cue : "",
    ].filter(Boolean).join("\n");
    try {
      const text = await callLLM({
        module: "lead-intelligence",
        prompt: userMsg,
        systemPrompt: systemPrompt,
        maxTokens: 4096
      });
      const clean = text.replace(/```json|```/g, "").trim();
      const obj = JSON.parse(clean);
      const g = graphSchema.safeParse(obj.graph ?? obj);
      if (!g.success) return { ok: false, errorCode: "assist_bad_shape", errorMessage: "bad_shape: " + JSON.stringify(g.error.flatten()).slice(0, 200) };
      return { ok: true, value: { graph: g.data } };
    } catch (err: any) {
      return { ok: false, errorCode: "llm_unavailable", errorMessage: String(err?.message ?? err).slice(0, 200) };
    }
  };

  const result = await recursiveRetry({ attempt, maxAttempts: 3, maxTotalMs: 30000 });
  res.json({ ...result });
});

export default router;
