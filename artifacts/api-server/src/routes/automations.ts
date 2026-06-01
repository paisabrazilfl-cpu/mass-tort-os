import { Router } from "express";
import { db, automationWorkflowsTable, automationRunsTable } from "@workspace/db";
import { eq, desc, and, or, isNull, sql, arrayContains } from "drizzle-orm";
import { z } from "zod/v4";
import { authMiddleware, Permission, requirePermission, requireRole } from "../lib/rbac";
import { badRequest, notFound, forbidden } from "../lib/http-errors";
import { NODE_CATALOG } from "../lib/automations/node-catalog";
import { runWorkflow } from "../lib/automations/executor";
import {
  readEnvConn,
  n8nPing,
  n8nSearchWorkflows,
  n8nExecuteWorkflow,
} from "../lib/automations/n8n-mcp";
import {
  assistGraphSchema,
  assistRequestSchema,
  validateAssistGraph,
  buildCatalogSummary,
  planAutomationGraph,
} from "../lib/automations/assist-planner";

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
  if (firmId == null) return isNull(automationWorkflowsTable.firm_id);
  return eq(automationWorkflowsTable.firm_id, firmId);
}
/**
 * Tag that marks a system-wide (firm_id IS NULL) workflow as a SHARED template
 * every firm may see and clone (e.g. the seeded intake→med-records pipelines).
 * Read access to null-firm rows is gated on this tag so an unrelated/global row
 * (which could carry sensitive trigger_config) is NOT silently exposed to every
 * tenant — only rows explicitly published as templates are shared.
 */
const SHARED_TEMPLATE_TAG = "seed:intake-pipeline";

/**
 * Read predicate: a firm can SEE its own workflows AND shared system templates
 * (firm_id IS NULL AND tagged with SHARED_TEMPLATE_TAG). System templates are
 * READ-ONLY to a firm — edit/delete still use the strict firmPredicate so one
 * tenant can never mutate a row another tenant sees. To customise a system
 * template, a firm clones it into its own firm (POST /:id/clone) and edits the
 * copy.
 */
function readPredicate(firmId: number | null | undefined) {
  if (firmId == null) return isNull(automationWorkflowsTable.firm_id);
  return or(
    eq(automationWorkflowsTable.firm_id, firmId),
    and(
      isNull(automationWorkflowsTable.firm_id),
      arrayContains(automationWorkflowsTable.tags, [SHARED_TEMPLATE_TAG]),
    ),
  );
}
function runFirmPredicate(firmId: number | null | undefined) {
  if (firmId == null) return isNull(automationRunsTable.firm_id);
  return eq(automationRunsTable.firm_id, firmId);
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

// ── n8n MCP bridge (CRM → n8n outbound) ──────────────────────────────
// Registered BEFORE the "/:id" routes so "/n8n/..." is not captured by the
// numeric-id matcher.
//
// TENANCY: these /n8n/* endpoints are the owner-level SYSTEM control plane.
// They use ONLY the global env instance (N8N_MCP_URL/TOKEN via readEnvConn) to
// list/execute ANY workflow in the owner's connected account, so they are gated
// to `super_admin` (the owner) ONLY, not to per-firm AUTOMATIONS_* permissions —
// otherwise any firm admin could enumerate/run workflows in the owner's n8n
// account (cross-tenant capability leak). requireRole("super_admin") admits
// only the top of the role hierarchy. NOTE: per-firm n8n isolation DOES exist
// for automation RUNS — the executor's integration.n8n_execute node resolves
// each firm's OWN vault connection via selectN8nConn/getN8nConnForFirm and never
// touches this global env instance. The env instance is system-scope only.
router.get("/n8n/status", requireRole("super_admin"), async (_req, res) => {
  const conn = readEnvConn();
  if (!conn) {
    res.json({ configured: false, ok: false, message: "Set N8N_MCP_URL and N8N_MCP_TOKEN to connect your n8n instance." });
    return;
  }
  try {
    const ping = await n8nPing(conn);
    res.json({ configured: true, ok: ping.ok, serverInfo: ping.serverInfo ?? null, toolCount: ping.toolCount ?? null });
  } catch (err) {
    res.json({ configured: true, ok: false, error: err instanceof Error ? err.message : "n8n unreachable" });
  }
});

router.get("/n8n/workflows", requireRole("super_admin"), async (req, res) => {
  const conn = readEnvConn();
  if (!conn) {
    badRequest(res, "n8n is not connected. Set N8N_MCP_URL and N8N_MCP_TOKEN.");
    return;
  }
  const query = typeof req.query.query === "string" ? req.query.query : undefined;
  const limit = Math.min(Math.max(Number(req.query.limit ?? 25) || 25, 1), 100);
  try {
    const out = await n8nSearchWorkflows(conn, { query, limit });
    res.json({ ok: true, workflows: out.data ?? out.text ?? null });
  } catch (err) {
    res.status(502).json({ error: err instanceof Error ? err.message : "n8n workflow search failed" });
  }
});

const n8nExecuteBody = z.object({
  workflowId: z.string().min(1),
  inputs: z.record(z.string(), z.any()).optional(),
  executionMode: z.enum(["production", "test"]).optional(),
});
router.post("/n8n/execute", requireRole("super_admin"), async (req, res) => {
  const conn = readEnvConn();
  if (!conn) {
    badRequest(res, "n8n is not connected. Set N8N_MCP_URL and N8N_MCP_TOKEN.");
    return;
  }
  const parsed = n8nExecuteBody.safeParse(req.body ?? {});
  if (!parsed.success) {
    badRequest(res, "Invalid request body", parsed.error.flatten());
    return;
  }
  try {
    const out = await n8nExecuteWorkflow(conn, {
      workflowId: parsed.data.workflowId,
      inputs: parsed.data.inputs ?? {},
      executionMode: parsed.data.executionMode ?? "production",
    });
    res.json({ ok: true, executionId: out.executionId, result: out.data ?? out.text ?? null });
  } catch (err) {
    res.status(502).json({ error: err instanceof Error ? err.message : "n8n execute failed" });
  }
});

router.get("/", requirePermission(Permission.AUTOMATIONS_VIEW), async (req, res) => {
  const firmId = req.user!.firm_id;
  const rows = await db
    .select({
      id: automationWorkflowsTable.id,
      firm_id: automationWorkflowsTable.firm_id,
      name: automationWorkflowsTable.name,
      description: automationWorkflowsTable.description,
      enabled: automationWorkflowsTable.enabled,
      trigger_type: automationWorkflowsTable.trigger_type,
      tags: automationWorkflowsTable.tags,
      updated_at: automationWorkflowsTable.updated_at,
      created_at: automationWorkflowsTable.created_at,
    })
    .from(automationWorkflowsTable)
    .where(readPredicate(firmId))
    .orderBy(desc(automationWorkflowsTable.updated_at));
  res.json(rows);
});

router.get("/:id", requirePermission(Permission.AUTOMATIONS_VIEW), async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) { badRequest(res, "id must be integer"); return; }
  const firmId = req.user!.firm_id;
  const [row] = await db.select().from(automationWorkflowsTable)
    .where(and(eq(automationWorkflowsTable.id, id), readPredicate(firmId))!)
    .limit(1);
  if (!row) { notFound(res, "Workflow not found"); return; }
  // Shared system templates (firm_id IS NULL) are visible to every tenant for
  // read/clone. Never expose their trigger_config — it may carry webhook
  // paths/secrets/privileged config that must not leak across firms. The
  // template's graph is the shareable part; the trigger is configured per-firm
  // after cloning.
  if (row.firm_id == null) {
    res.json({ ...row, trigger_config: {} });
    return;
  }
  res.json(row);
});

router.post("/", requirePermission(Permission.AUTOMATIONS_MANAGE), async (req, res) => {
  const parsed = upsertSchema.safeParse(req.body);
  if (!parsed.success) { badRequest(res, "Invalid body", parsed.error.flatten()); return; }
  const userId = req.user!.id;
  const firmId = req.user!.firm_id;
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

router.put("/:id", requirePermission(Permission.AUTOMATIONS_MANAGE), async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) { badRequest(res, "id must be integer"); return; }
  const parsed = upsertSchema.partial().safeParse(req.body);
  if (!parsed.success) { badRequest(res, "Invalid body", parsed.error.flatten()); return; }
  const firmId = req.user!.firm_id;
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
  const firmId = req.user!.firm_id;
  // Verify ownership before delete.
  const [own] = await db.select({ id: automationWorkflowsTable.id }).from(automationWorkflowsTable)
    .where(and(eq(automationWorkflowsTable.id, id), firmPredicate(firmId))!).limit(1);
  if (!own) { notFound(res, "Workflow not found"); return; }
  await db.delete(automationRunsTable).where(eq(automationRunsTable.workflow_id, id));
  const result = await db.delete(automationWorkflowsTable).where(eq(automationWorkflowsTable.id, id));
  res.json({ deleted: (result as any).rowCount ?? 1 });
});

/**
 * Clone a workflow the caller can SEE (its own or a system template) into the
 * caller's firm as a fresh, disabled draft. This is how an operator adopts a
 * system-wide seed (e.g. the intake→med-records pipelines): clone it, fill in
 * the per-firm template ids, then enable the copy — without ever mutating the
 * shared global template that every other firm also sees.
 */
router.post("/:id/clone", requirePermission(Permission.AUTOMATIONS_MANAGE), async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) { badRequest(res, "id must be integer"); return; }
  const userId = req.user!.id;
  const firmId = req.user!.firm_id;
  const [src] = await db.select().from(automationWorkflowsTable)
    .where(and(eq(automationWorkflowsTable.id, id), readPredicate(firmId))!).limit(1);
  if (!src) { notFound(res, "Workflow not found"); return; }
  // Drop seed bookkeeping tags from the copy so it reads as a firm-owned
  // workflow, and record where it came from for traceability.
  const tags = (Array.isArray(src.tags) ? src.tags : [])
    .filter((t) => t !== "seed:intake-pipeline" && !t.startsWith("cloned-from:"))
    .concat(`cloned-from:${src.id}`);
  // Never carry a shared system template's trigger_config into a tenant's copy —
  // it may hold webhook paths/secrets, and the firm-owned copy is readable
  // unredacted, which would otherwise let any firm exfiltrate it by cloning. The
  // operator configures the trigger per-firm on the disabled draft.
  const triggerConfig = src.firm_id == null ? {} : src.trigger_config;
  const [row] = await db.insert(automationWorkflowsTable).values({
    firm_id: firmId ?? null,
    name: `${src.name} (copy)`.slice(0, 200),
    description: src.description ?? null,
    graph: src.graph,
    enabled: false,
    trigger_type: src.trigger_type,
    trigger_config: triggerConfig,
    tags,
    created_by_user_id: userId ?? null,
  } as typeof automationWorkflowsTable.$inferInsert).returning();
  res.status(201).json(row);
});

router.post("/:id/run", requirePermission(Permission.AUTOMATIONS_EXECUTE), async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) { badRequest(res, "id must be integer"); return; }
  const parsed = runBodySchema.safeParse(req.body ?? {});
  if (!parsed.success) { badRequest(res, "Invalid body", parsed.error.flatten()); return; }
  const userId = req.user!.id;
  const firmId = req.user!.firm_id;
  // Verify access before invoking executor — a firm may test-run its own
  // workflows OR a system template (it executes against the caller's firm).
  const [own] = await db.select({ id: automationWorkflowsTable.id }).from(automationWorkflowsTable)
    .where(and(eq(automationWorkflowsTable.id, id), readPredicate(firmId))!).limit(1);
  if (!own) { notFound(res, "Workflow not found"); return; }
  try {
    const result = await runWorkflow({
      workflowId: id,
      firmId: firmId ?? null,
      input: (parsed.data.input ?? {}) as Record<string, unknown>,
      triggerSource: "manual",
      startedByUserId: userId ?? null,
    });
    res.json(result);
  } catch (err: unknown) {
    res.status(500).json({ error: err instanceof Error ? err.message : "Run failed" });
  }
});

router.get("/:id/runs", requirePermission(Permission.AUTOMATIONS_VIEW), async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) { badRequest(res, "id must be integer"); return; }
  const firmId = req.user!.firm_id;
  // Verify access before exposing run history (own workflows + system templates).
  const [own] = await db.select({ id: automationWorkflowsTable.id }).from(automationWorkflowsTable)
    .where(and(eq(automationWorkflowsTable.id, id), readPredicate(firmId))!).limit(1);
  if (!own) { notFound(res, "Workflow not found"); return; }
  const limit = Math.min(Number(req.query.limit ?? 50), 200);
  const rows = await db.select().from(automationRunsTable)
    .where(and(eq(automationRunsTable.workflow_id, id), runFirmPredicate(firmId))!)
    .orderBy(desc(automationRunsTable.started_at))
    .limit(limit);
  res.json(rows);
});

router.get("/runs/:runId", requirePermission(Permission.AUTOMATIONS_VIEW), async (req, res) => {
  const runId = Number(req.params.runId);
  if (!Number.isInteger(runId)) { badRequest(res, "runId must be integer"); return; }
  const firmId = req.user!.firm_id;
  const [row] = await db.select().from(automationRunsTable)
    .where(and(eq(automationRunsTable.id, runId), runFirmPredicate(firmId))!)
    .limit(1);
  if (!row) { notFound(res, "Run not found"); return; }
  res.json(row);
});

// ────────────────────────────────────────────────────────────────────────────
// AI Assist — drawer-driven workflow builder. Operators describe what they
// want in plain English; the assistant proposes a graph patch that the editor
// can apply. The patch is validated against NODE_CATALOG server-side so the
// model can never inject an unknown node type or a free-form output edge.
// ────────────────────────────────────────────────────────────────────────────

router.post("/assist", requirePermission(Permission.AUTOMATIONS_MANAGE), async (req, res) => {
  const parsed = assistRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ status: "error", code: "bad_request", message: "Invalid assist request", details: parsed.error.flatten() });
    return;
  }
  const { mode } = parsed.data;

  // The planning engine is shared with Abby (the internal agent) so both
  // surfaces get the exact same catalog, validation, and retry behavior.
  const result = await planAutomationGraph(parsed.data);

  if (!result.ok) {
    // Map the last error code to an HTTP status: transport failures
    // are 502, validation failures are 422.
    const httpStatus = result.code === "llm_unavailable" ? 502 : 422;
    res.status(httpStatus).json({
      status: "error",
      code: result.code,
      message: result.message,
      details: result.details,
      // Surface the full audit trail so the operator can see WHAT we
      // tried and WHY each attempt failed — without this, the recursive
      // retry is a black box that just burns LLM credits.
      retry: {
        attempts: result.attempts,
        stopped_reason: result.stoppedReason,
      },
    });
    return;
  }

  res.json({
    status: "ok",
    explanation: result.explanation,
    graph: result.graph,
    warnings: result.warnings,
    mode,
    // On success, still surface the retry log when more than one
    // attempt was needed — useful telemetry for tuning the perspective
    // cues over time.
    ...(result.attempts.length > 1
      ? { retry: { attempts: result.attempts, stopped_reason: result.stoppedReason } }
      : {}),
  });
});

// Exported for tests. Keep them out of the catalog/handler surface.
export const __assistInternals = { validateAssistGraph, buildCatalogSummary, assistGraphSchema };

export default router;
