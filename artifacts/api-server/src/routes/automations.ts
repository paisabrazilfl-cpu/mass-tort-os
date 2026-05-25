import { Router } from "express";
import { db, pool, automationWorkflowsTable, automationRunsTable } from "@workspace/db";
import { eq, desc, and } from "drizzle-orm";
import { z } from "zod/v4";
import { authMiddleware, Permission, requirePermission } from "../lib/rbac";
import { badRequest, notFound, serverError } from "../lib/http-errors";
import { NODE_CATALOG } from "../lib/automations/node-catalog";
import { runWorkflow } from "../lib/automations/executor";
import { callLLM } from "../lib/ai-provider";
import { getAiConstitutionPreamble } from "../lib/ai-constitution";
import { recursiveRetry, perspectiveCue } from "../lib/automations/recursive-retry";
import { resilientRetry, isResiliencyV2Enabled } from "../lib/ai/resilient-retry";
import { requireFirmId } from "../lib/firm-scope";
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
// REMOVED: `fWhere(firmId)` raw-SQL helper. The original implementation
// returned "1=1" when firmId was null and "firm_id = X OR firm_id IS NULL"
// otherwise. Two bugs in one helper:
//   1. The "1=1" fallback turned a missing firm context into "list every
//      firm's workflows" — cross-firm data leak.
//   2. The "OR firm_id IS NULL" branch leaked pre-backfill legacy rows to
//      every firm regardless of their actual ownership.
// AND the callers read firmId from `(req as any).firmId`, which is never
// set anywhere in the codebase — `req.user.firm_id` and `req.firm.id` are
// the real fields. So fWhere was effectively ALWAYS returning "1=1" in
// production, leaking every workflow row across every firm.
//
// Replaced with `requireFirmId(req)` + parameterized Drizzle queries at
// every callsite. Legacy NULL-firm_id rows must be backfilled via
// `scripts/backfill-automation-workflows-firm-id.sql` before the new
// scope takes effect; until then those rows are invisible to every firm
// (safer than the previous "visible to every firm" failure mode).

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
//
// NOTE: POST /webhook/:slugOrId is intentionally NOT defined here. The public
// webhook handler lives in `routes/automations-webhook.ts` and is mounted at
// `/api/automations` BEFORE the auth middleware in `routes/index.ts`. The
// previous in-file copy of the route sat behind authMiddleware and was
// therefore unreachable to external providers — every signed callback 401d.
//
router.get("/", requirePermission(Permission.AUTOMATIONS_VIEW), async (req, res) => {
  await repairSchema();
  try {
    const firmId = requireFirmId(req);
    const rows = await db
      .select({
        id: automationWorkflowsTable.id,
        name: automationWorkflowsTable.name,
        description: automationWorkflowsTable.description,
        enabled: automationWorkflowsTable.enabled,
        trigger_type: automationWorkflowsTable.trigger_type,
        tags: automationWorkflowsTable.tags,
        updated_at: automationWorkflowsTable.updated_at,
        created_at: automationWorkflowsTable.created_at,
      })
      .from(automationWorkflowsTable)
      .where(eq(automationWorkflowsTable.firm_id, firmId))
      .orderBy(desc(automationWorkflowsTable.updated_at));
    res.json(rows);
  } catch (err: any) {
    logger.error({ err: err?.message }, "automations GET / failed");
    serverError(res, "Failed to list workflows");
  }
});

// ── Get single workflow ───────────────────────────────────────────────────────
router.get("/:id", requirePermission(Permission.AUTOMATIONS_VIEW), async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) { badRequest(res, "id must be integer"); return; }
  try {
    const firmId = requireFirmId(req);
    const [row] = await db
      .select()
      .from(automationWorkflowsTable)
      .where(and(eq(automationWorkflowsTable.id, id), eq(automationWorkflowsTable.firm_id, firmId)))
      .limit(1);
    if (!row) { notFound(res, "Workflow not found"); return; }
    res.json(row);
  } catch (err: any) {
    logger.error({ err: err?.message, id }, "automations GET /:id failed");
    serverError(res, "Failed to load workflow");
  }
});

// ── Create workflow ───────────────────────────────────────────────────────────
router.post("/", requirePermission(Permission.AUTOMATIONS_MANAGE), async (req, res) => {
  const parsed = upsertSchema.safeParse(req.body);
  if (!parsed.success) { badRequest(res, "Invalid body", parsed.error.flatten()); return; }
  await repairSchema();
  try {
    const firmId = requireFirmId(req);
    const userId = req.user?.id;
    const [row] = await db.insert(automationWorkflowsTable).values({
      name: parsed.data.name,
      description: parsed.data.description ?? null,
      graph: parsed.data.graph,
      enabled: parsed.data.enabled ?? false,
      trigger_type: parsed.data.trigger_type ?? "manual",
      trigger_config: parsed.data.trigger_config ?? {},
      tags: parsed.data.tags ?? [],
      firm_id: firmId,
      created_by_user_id: userId ?? null,
    } as any).returning();
    res.status(201).json(row);
  } catch (err: any) {
    logger.error({ err: err?.message }, "automations POST / failed");
    serverError(res, "Failed to create workflow");
  }
});

// ── Update workflow ───────────────────────────────────────────────────────────
router.put("/:id", requirePermission(Permission.AUTOMATIONS_MANAGE), async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) { badRequest(res, "id must be integer"); return; }
  const parsed = upsertSchema.partial().safeParse(req.body);
  if (!parsed.success) { badRequest(res, "Invalid body", parsed.error.flatten()); return; }
  try {
    const firmId = requireFirmId(req);
    const [row] = await db.update(automationWorkflowsTable)
      .set({ ...parsed.data, updated_at: new Date() } as any)
      .where(and(eq(automationWorkflowsTable.id, id), eq(automationWorkflowsTable.firm_id, firmId)))
      .returning();
    if (!row) { notFound(res, "Workflow not found"); return; }
    res.json(row);
  } catch (err: any) {
    logger.error({ err: err?.message, id }, "automations PUT /:id failed");
    serverError(res, "Failed to update workflow");
  }
});

// ── Delete workflow ───────────────────────────────────────────────────────────
router.delete("/:id", requirePermission(Permission.AUTOMATIONS_MANAGE), async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) { badRequest(res, "id must be integer"); return; }
  try {
    const firmId = requireFirmId(req);
    const deleted = await db.delete(automationWorkflowsTable)
      .where(and(eq(automationWorkflowsTable.id, id), eq(automationWorkflowsTable.firm_id, firmId)))
      .returning({ id: automationWorkflowsTable.id });
    res.json({ deleted: deleted.length });
  } catch (err: any) {
    logger.error({ err: err?.message, id }, "automations DELETE /:id failed");
    serverError(res, "Failed to delete workflow");
  }
});

// ── Run workflow ──────────────────────────────────────────────────────────────
router.post("/:id/run", requirePermission(Permission.AUTOMATIONS_EXECUTE), async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) { badRequest(res, "id must be integer"); return; }
  const parsed = runBodySchema.safeParse(req.body ?? {});
  if (!parsed.success) { badRequest(res, "Invalid body", parsed.error.flatten()); return; }
  try {
    const firmId = requireFirmId(req);
    const userId = req.user?.id;
    const [check] = await db
      .select({ id: automationWorkflowsTable.id })
      .from(automationWorkflowsTable)
      .where(and(eq(automationWorkflowsTable.id, id), eq(automationWorkflowsTable.firm_id, firmId)))
      .limit(1);
    if (!check) { notFound(res, "Workflow not found"); return; }
    const result = await runWorkflow({
      workflowId: id,
      firmId,
      input: (parsed.data.input ?? {}) as Record<string, unknown>,
      triggerSource: "manual",
      startedByUserId: userId ?? null,
    });
    res.json(result);
  } catch (err: any) {
    logger.error({ err: err?.message, id }, "automations POST /:id/run failed");
    serverError(res, err?.message ?? "Run failed");
  }
});

// ── Run history for workflow ──────────────────────────────────────────────────
router.get("/:id/runs", requirePermission(Permission.AUTOMATIONS_VIEW), async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) { badRequest(res, "id must be integer"); return; }
  const firmId = requireFirmId(req);
  try {
    const rows = await db
      .select({
        id: automationRunsTable.id,
        workflow_id: automationRunsTable.workflow_id,
        status: automationRunsTable.status,
        trigger_source: automationRunsTable.trigger_source,
        started_at: automationRunsTable.started_at,
        completed_at: automationRunsTable.completed_at,
        error: automationRunsTable.error,
      })
      .from(automationRunsTable)
      .where(and(eq(automationRunsTable.workflow_id, id), eq(automationRunsTable.firm_id, firmId)))
      .orderBy(desc(automationRunsTable.started_at))
      .limit(50);
    res.json(rows);
  } catch (err: any) {
    logger.error({ err: err?.message, id }, "automations /:id/runs failed");
    serverError(res, "Failed to load run history");
  }
});

// ── Single run detail ─────────────────────────────────────────────────────────
router.get("/runs/:runId", requirePermission(Permission.AUTOMATIONS_VIEW), async (req, res) => {
  const runId = Number(req.params.runId);
  if (!Number.isInteger(runId)) { badRequest(res, "runId must be integer"); return; }
  const firmId = requireFirmId(req);
  try {
    const [row] = await db
      .select()
      .from(automationRunsTable)
      .where(and(eq(automationRunsTable.id, runId), eq(automationRunsTable.firm_id, firmId)))
      .limit(1);
    if (!row) { notFound(res, "Run not found"); return; }
    const sl = row.step_log ?? [];
    res.json({ ...row, steps: sl, runId: row.id });
  } catch (err: any) {
    logger.error({ err: err?.message, runId }, "automations /runs/:runId failed");
    serverError(res, "Failed to load run");
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

  // AI Resiliency v2 wiring. When AI_RESILIENCY_V2=1 is set, the AI
  // Helper retry loop runs through resilientRetry which composes
  // per-provider circuit breaker + error classifier + per-attempt
  // timeout + structured state-transition events. When the flag is
  // absent or any other value, the existing recursiveRetry path
  // executes byte-identically to before — no behavior change.
  //
  // The wrapper itself catches its own exceptions and falls back to
  // recursiveRetry if anything in the resiliency layer misbehaves,
  // so even with the flag ON the worst case is "no v2 benefit," not
  // "broken AI Helper."
  const retryFn = isResiliencyV2Enabled()
    ? <T,>(opts: Parameters<typeof recursiveRetry<T>>[0]) =>
        resilientRetry<T>({ ...opts, provider: "automations-assist" })
    : recursiveRetry;

  const result = await retryFn({
    maxAttempts: 3,
    maxTotalMs: 30_000,
    attempt: async ({ perspectiveIndex, previousError }) => {
      const cue = perspectiveCue(perspectiveIndex);
      const userMsg = [
        parsed.data.prompt,
        previousError
          ? [
              `Previous attempt failed with ${previousError.code}: ${previousError.message}`,
              cue,
            ].filter(Boolean).join("\n")
          : cue,
      ].filter(Boolean).join("\n");

      try {
        // callLLM takes a single LLMRequest object, not a chat-message array
        // (see lib/ai-provider.ts). Concatenate the user message into `prompt`
        // and pass the role-system text via `systemPrompt`.
        const text = await callLLM({
          module: "automations-assist",
          prompt: userMsg,
          systemPrompt,
          maxTokens: 4096,
        });
        const clean = text.replace(/```json|```/g, "").trim();
        const obj = JSON.parse(clean);
        const g = graphSchema.safeParse(obj.graph ?? obj);
        if (!g.success) {
          return {
            ok: false as const,
            errorCode: "bad_shape",
            errorMessage: JSON.stringify(g.error.flatten()).slice(0, 500),
          };
        }
        return { ok: true as const, value: { graph: g.data } };
      } catch (err: any) {
        return {
          ok: false as const,
          errorCode: "llm_or_json_error",
          errorMessage: String(err?.message ?? err).slice(0, 500),
        };
      }
    },
  });

  if (!result.ok) {
    res.status(422).json(result);
    return;
  }

  res.json(result);
});

export default router;

