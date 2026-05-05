import { Router } from "express";
import { db, automationWorkflowsTable, automationRunsTable } from "@workspace/db";
import { eq, desc, and, or, isNull, sql } from "drizzle-orm";
import { z } from "zod/v4";
import { authMiddleware, Permission, requirePermission } from "../lib/rbac";
import { badRequest, notFound, forbidden } from "../lib/http-errors";
import { NODE_CATALOG } from "../lib/automations/node-catalog";
import { runWorkflow } from "../lib/automations/executor";

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
  const firmId = (req as any).firmId as number | undefined;
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
  const firmId = (req as any).firmId as number | undefined;
  const [row] = await db.select().from(automationWorkflowsTable)
    .where(and(eq(automationWorkflowsTable.id, id), firmPredicate(firmId))!)
    .limit(1);
  if (!row) { notFound(res, "Workflow not found"); return; }
  res.json(row);
});

router.post("/", requirePermission(Permission.AUTOMATIONS_MANAGE), async (req, res) => {
  const parsed = upsertSchema.safeParse(req.body);
  if (!parsed.success) { badRequest(res, "Invalid body", parsed.error.flatten()); return; }
  const userId = (req as any).user?.id as number | undefined;
  const firmId = (req as any).firmId as number | undefined;
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
  const firmId = (req as any).firmId as number | undefined;
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
  const firmId = (req as any).firmId as number | undefined;
  const [row] = await db.select().from(automationRunsTable)
    .where(and(eq(automationRunsTable.id, runId), runFirmPredicate(firmId))!)
    .limit(1);
  if (!row) { notFound(res, "Run not found"); return; }
  res.json(row);
});

export default router;
