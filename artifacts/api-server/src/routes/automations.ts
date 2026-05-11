import { Router } from "express";
import { db, automationWorkflowsTable, automationRunsTable } from "@workspace/db";
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

router.get("/", requirePermission(Permission.AUTOMATIONS_VIEW), async (req, res) => {
  const firmId = req.user!.firm_id;
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
    .where(firmPredicate(firmId))
    .orderBy(desc(automationWorkflowsTable.updated_at));
  res.json(rows);
});

router.get("/:id", requirePermission(Permission.AUTOMATIONS_VIEW), async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) { badRequest(res, "id must be integer"); return; }
  const firmId = req.user!.firm_id;
  const [row] = await db.select().from(automationWorkflowsTable)
    .where(and(eq(automationWorkflowsTable.id, id), firmPredicate(firmId))!)
    .limit(1);
  if (!row) { notFound(res, "Workflow not found"); return; }
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

router.post("/:id/run", requirePermission(Permission.AUTOMATIONS_EXECUTE), async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) { badRequest(res, "id must be integer"); return; }
  const parsed = runBodySchema.safeParse(req.body ?? {});
  if (!parsed.success) { badRequest(res, "Invalid body", parsed.error.flatten()); return; }
  const userId = req.user!.id;
  const firmId = req.user!.firm_id;
  // Verify ownership before invoking executor.
  const [own] = await db.select({ id: automationWorkflowsTable.id }).from(automationWorkflowsTable)
    .where(and(eq(automationWorkflowsTable.id, id), firmPredicate(firmId))!).limit(1);
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
  } catch (err: any) {
    res.status(500).json({ error: err?.message ?? "Run failed" });
  }
});

router.get("/:id/runs", requirePermission(Permission.AUTOMATIONS_VIEW), async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) { badRequest(res, "id must be integer"); return; }
  const firmId = req.user!.firm_id;
  // Verify ownership before exposing run history.
  const [own] = await db.select({ id: automationWorkflowsTable.id }).from(automationWorkflowsTable)
    .where(and(eq(automationWorkflowsTable.id, id), firmPredicate(firmId))!).limit(1);
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

const assistGraphSchema = z.object({
  nodes: z.array(z.object({
    // id is required, but accept numeric ids that some LLMs emit and coerce
    // to string so the editor's React Flow layer (which keys on string ids)
    // doesn't blow up downstream.
    id: z.union([z.string().min(1), z.number()]).transform((v) => String(v)),
    type: z.string().min(1),
    position: z.object({ x: z.number(), y: z.number() }).optional(),
    data: z.object({
      label: z.string().optional(),
      params: z.record(z.string(), z.any()).optional(),
    }).optional(),
  })).default([]),
  // Edge `id` is conventionally auto-generated by React Flow on the client,
  // so most LLMs (and most hand-authored examples) omit it. Accept missing
  // ids and synthesize a stable one from source→target so the editor and the
  // executor both have a unique key. Also accept numeric source/target ids.
  edges: z.array(z.object({
    id: z.string().min(1).optional(),
    source: z.union([z.string().min(1), z.number()]).transform((v) => String(v)),
    target: z.union([z.string().min(1), z.number()]).transform((v) => String(v)),
    sourceHandle: z.string().nullable().optional(),
    targetHandle: z.string().nullable().optional(),
  })).default([]).transform((edges) => {
    const seen = new Set<string>();
    return edges.map((e, i) => {
      let id = e.id ?? `e_${e.source}_${e.target}${e.sourceHandle ? `_${e.sourceHandle}` : ""}`;
      // De-dup if two edges resolve to the same synthesized id.
      while (seen.has(id)) id = `${id}_${i}`;
      seen.add(id);
      return { ...e, id };
    });
  }),
});

const assistRequestSchema = z.object({
  prompt: z.string().min(3).max(4000),
  currentGraph: assistGraphSchema.optional(),
  mode: z.enum(["replace", "patch"]).default("replace"),
});

/**
 * Validate an assistant-produced graph against NODE_CATALOG. Returns the list
 * of issues; empty array means the graph is safe to surface to the editor.
 */
function validateAssistGraph(graph: z.infer<typeof assistGraphSchema>): { issues: string[]; warnings: string[] } {
  const issues: string[] = [];
  const warnings: string[] = [];
  const ids = new Set<string>();
  for (const n of graph.nodes) {
    if (ids.has(n.id)) { issues.push(`Duplicate node id "${n.id}".`); continue; }
    ids.add(n.id);
    const def = getNodeDefinition(n.type);
    if (!def) { issues.push(`Unknown node type "${n.type}" (id ${n.id}).`); continue; }
    // Param key allowlist: every key under data.params must correspond to a
    // declared NodeParamSpec for this node type. Unknown keys are STRIPPED
    // (not rejected) — LLMs occasionally leak edge-level fields like
    // `sourceHandle` into a node's params, or invent helper keys the
    // handler would silently ignore. Stripping keeps the workflow usable
    // and reports the dropped keys as warnings the operator can review.
    const declared = new Set(def.params.map((p) => p.key));
    const params = n.data?.params ?? {};
    const stripped: string[] = [];
    for (const key of Object.keys(params)) {
      if (!declared.has(key)) {
        delete (params as Record<string, unknown>)[key];
        stripped.push(key);
      }
    }
    if (stripped.length > 0) {
      warnings.push(`Node ${n.id} (${n.type}): stripped unknown params [${stripped.join(", ")}]. Allowed: [${def.params.map((p) => p.key).join(", ") || "—"}].`);
    }
  }
  for (const e of graph.edges) {
    if (!ids.has(e.source)) issues.push(`Edge ${e.id}: source "${e.source}" is not a node in this graph.`);
    if (!ids.has(e.target)) issues.push(`Edge ${e.id}: target "${e.target}" is not a node in this graph.`);
    if (e.sourceHandle) {
      const sourceNode = graph.nodes.find((n) => n.id === e.source);
      if (sourceNode) {
        const def = getNodeDefinition(sourceNode.type);
        const outs = def?.outputs;
        if (Array.isArray(outs) && !outs.includes(e.sourceHandle)) {
          issues.push(`Edge ${e.id}: sourceHandle "${e.sourceHandle}" is not declared on ${sourceNode.type} (allowed: ${outs.join(", ")}).`);
        }
      }
    }
  }
  return { issues, warnings };
}

/**
 * Compact catalog summary used in the assistant system prompt. Keeping it
 * tight so we don't burn tokens on every call. Outputs are listed verbatim
 * so the model knows the legal sourceHandle values for branching nodes.
 */
function buildCatalogSummary(): string {
  const byCat: Record<string, string[]> = {};
  for (const def of NODE_CATALOG) {
    const outs = Array.isArray(def.outputs) ? `[${def.outputs.join("|")}]` : "*";
    // Render param keys as a plain comma-separated list. Earlier we appended
    // a trailing "!" to required keys, but several LLMs faithfully copied
    // the marker INTO the key name (e.g. emitted `"labels!": [...]`), which
    // then failed catalog validation. Required-ness is not enforced by
    // validateAssistGraph anyway; if a node truly needs a value the handler
    // will fail at run time with a helpful error.
    const required = def.params.filter((p) => p.required).map((p) => p.key);
    const optional = def.params.filter((p) => !p.required).map((p) => p.key);
    const parts: string[] = [];
    if (required.length) parts.push(`req=${required.join(",")}`);
    if (optional.length) parts.push(`opt=${optional.join(",")}`);
    const paramsStr = parts.length ? ` ${parts.join(" ")}` : "";
    (byCat[def.category] ??= []).push(`  ${def.type} ${outs}${paramsStr}`);
  }
  return Object.entries(byCat).map(([cat, lines]) => `[${cat}]\n${lines.join("\n")}`).join("\n");
}

router.post("/assist", requirePermission(Permission.AUTOMATIONS_MANAGE), async (req, res) => {
  const parsed = assistRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ status: "error", code: "bad_request", message: "Invalid assist request", details: parsed.error.flatten() });
    return;
  }
  const { prompt, currentGraph, mode } = parsed.data;

  const catalogSummary = buildCatalogSummary();
  const constitutionPreamble = getAiConstitutionPreamble();
  const systemPrompt = [
    constitutionPreamble,
    "",
    "You are an expert workflow architect for MTOS Automation Center.",
    "Given a plain-English request, produce a workflow graph in JSON.",
    "STRICT RULES:",
    "- Output ONE JSON object only — no prose, no code fences.",
    `- Shape: { "explanation": string, "graph": { "nodes": [...], "edges": [...] } }`,
    "- Every node MUST use a `type` from the catalog below. Do not invent new types.",
    "- Every node needs `id` (unique short string), `type`, `position` ({x,y}), and `data.label`.",
    "- Put node-specific config under `data.params`.",
    "- Every workflow must start with exactly one trigger.* node.",
    "- For branching nodes (outputs listed as [a|b|c]), set edge `sourceHandle` to one of those names.",
    "- For non-branching nodes, omit sourceHandle.",
    "- Position nodes left-to-right with x increasing by ~220 per step, y around 200.",
    "- Edges are objects with `source` and `target` (node ids); `id` is optional and will be generated if omitted.",
    "",
    "CATALOG:",
    catalogSummary,
  ].join("\n");

  const baseUserPrompt = [
    `User request: ${prompt}`,
    currentGraph
      ? `\nCurrent graph (mode=${mode}):\n${JSON.stringify(currentGraph).slice(0, 8_000)}`
      : "\n(No existing graph — build from scratch.)",
  ].join("\n");

  // Successful payload shape returned to the operator on a good attempt.
  type AssistOk = {
    explanation: string;
    graph: ReturnType<typeof assistGraphSchema.parse>;
    warnings: ReturnType<typeof validateAssistGraph>["warnings"];
  };

  // One attempt = one LLM call + JSON parse + schema check + catalog
  // validation. Each failure mode is converted to a structured
  // AttemptOutcome so the recursiveRetry primitive can feed the previous
  // error into the next perspective shift.
  //
  // We deliberately retry transport failures (`llm_unavailable`) too —
  // the underlying provider router has its own fallback to the Anthropic
  // env-key adapter, but a transient 5xx on the chosen provider can
  // resolve on the next call.
  const runOneAttempt = async (
    ctx: { perspectiveIndex: number; totalAttempts: number; previousError: { code: string; message: string } | null },
  ): Promise<AttemptOutcome<AssistOk>> => {
    // Build the user prompt for this attempt: base + perspective cue +
    // (on retries) a compact summary of the previous failure so the
    // model can correct rather than guess.
    const cue = perspectiveCue(ctx.perspectiveIndex);
    const previousErrorBlock = ctx.previousError
      ? `\nPREVIOUS ATTEMPT FAILED:\n  code: ${ctx.previousError.code}\n  message: ${ctx.previousError.message.slice(0, 600)}\nAddress this in your next response.`
      : "";
    const attemptUserPrompt = [
      baseUserPrompt,
      cue ? `\n${cue}` : "",
      previousErrorBlock,
    ].filter(Boolean).join("\n");

    let raw: string;
    try {
      raw = await callLLM({
        module: "lead-intelligence",
        systemPrompt,
        prompt: attemptUserPrompt,
        maxTokens: 2500,
      });
    } catch (err: any) {
      return {
        ok: false,
        errorCode: "llm_unavailable",
        errorMessage: err?.message ?? "AI provider unreachable",
      };
    }

    // Strip code fences the model sometimes adds despite instructions.
    const cleaned = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/```$/m, "").trim();
    let payload: { explanation?: string; graph?: unknown };
    try {
      payload = JSON.parse(cleaned);
    } catch {
      return {
        ok: false,
        errorCode: "assist_invalid_json",
        errorMessage: "Assistant did not return valid JSON.",
        errorDetails: { raw: cleaned.slice(0, 800) },
      };
    }

    const graphParse = assistGraphSchema.safeParse(payload?.graph);
    if (!graphParse.success) {
      return {
        ok: false,
        errorCode: "assist_bad_shape",
        errorMessage: "Assistant produced a graph that does not match the expected shape.",
        errorDetails: graphParse.error.flatten(),
      };
    }

    const { issues, warnings } = validateAssistGraph(graphParse.data);
    if (issues.length > 0) {
      return {
        ok: false,
        errorCode: "assist_catalog_violation",
        errorMessage: `Graph uses unknown nodes or invalid edges: ${issues.slice(0, 3).map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join("; ")}`,
        errorDetails: { issues, warnings, graph: graphParse.data },
      };
    }

    return {
      ok: true,
      value: {
        explanation: typeof payload.explanation === "string" ? payload.explanation : "",
        graph: graphParse.data,
        warnings,
      },
    };
  };

  const result = await recursiveRetry({
    attempt: runOneAttempt,
    // 4 total attempts (original + 3 retries). The hard ceiling in
    // recursive-retry.ts caps anything beyond 6, so even if we bump
    // this we cannot accidentally loop forever.
    maxAttempts: 4,
    // 30s wall-clock cap across all attempts — protects request budget
    // and prevents a slow LLM from holding the connection open.
    maxTotalMs: 30_000,
  });

  if (!result.ok) {
    // Map the last error code to an HTTP status: transport failures
    // are 502, validation failures are 422.
    const httpStatus = result.lastError.code === "llm_unavailable" ? 502 : 422;
    logger.warn(
      {
        code: result.lastError.code,
        attempts: result.attempts.length,
        stoppedReason: result.stoppedReason,
      },
      "automation.assist: all retries failed",
    );
    res.status(httpStatus).json({
      status: "error",
      code: result.lastError.code,
      message: result.lastError.message,
      details: result.lastError.details,
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
    explanation: result.value.explanation,
    graph: result.value.graph,
    warnings: result.value.warnings,
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
