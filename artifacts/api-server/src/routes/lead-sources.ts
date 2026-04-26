import { Router } from "express";
import { db, leadSourcesTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { authMiddleware, Permission, requirePermission } from "../lib/rbac";
import { z } from "zod/v4";
import { badRequest, conflict, notFound } from "../lib/http-errors";

const router = Router();
router.use(authMiddleware);

const sourceSchema = z.object({
  name: z.string().min(1).max(255),
  channel: z.string().min(1).max(50).default("other"),
  cost_per_lead: z.number().nonnegative().nullable().optional(),
  historical_qualified_rate: z.number().min(0).max(1).nullable().optional(),
  historical_retained_rate: z.number().min(0).max(1).nullable().optional(),
  active: z.boolean().optional(),
});

router.get("/", requirePermission(Permission.LEAD_SOURCES_VIEW), async (_req, res) => {
  const rows = await db.select().from(leadSourcesTable).orderBy(leadSourcesTable.name);
  res.json(rows);
});

router.post("/", requirePermission(Permission.LEAD_SOURCES_MANAGE), async (req, res) => {
  const parsed = sourceSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const d = parsed.data;
  try {
    const [row] = await db
      .insert(leadSourcesTable)
      .values({
        name: d.name,
        channel: d.channel,
        cost_per_lead: d.cost_per_lead != null ? String(d.cost_per_lead) : null,
        historical_qualified_rate: d.historical_qualified_rate != null ? String(d.historical_qualified_rate) : null,
        historical_retained_rate: d.historical_retained_rate != null ? String(d.historical_retained_rate) : null,
        active: d.active ?? true,
      })
      .returning();
    res.status(201).json(row);
  } catch (e: any) {
    if (String(e?.message || "").includes("duplicate")) {
      conflict(res, "name_taken", "A lead source with this name already exists");
      return;
    }
    throw e;
  }
});

router.put("/:id", requirePermission(Permission.LEAD_SOURCES_MANAGE), async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) {
    badRequest(res, "invalid_id");
    return;
  }
  const parsed = sourceSchema.partial().safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const d = parsed.data;
  const updates: Record<string, unknown> = { updated_at: new Date() };
  if (d.name !== undefined) updates.name = d.name;
  if (d.channel !== undefined) updates.channel = d.channel;
  if (d.cost_per_lead !== undefined)
    updates.cost_per_lead = d.cost_per_lead != null ? String(d.cost_per_lead) : null;
  if (d.historical_qualified_rate !== undefined)
    updates.historical_qualified_rate = d.historical_qualified_rate != null ? String(d.historical_qualified_rate) : null;
  if (d.historical_retained_rate !== undefined)
    updates.historical_retained_rate = d.historical_retained_rate != null ? String(d.historical_retained_rate) : null;
  if (d.active !== undefined) updates.active = d.active;

  const [row] = await db.update(leadSourcesTable).set(updates).where(eq(leadSourcesTable.id, id)).returning();
  if (!row) {
    notFound(res, "not_found");
    return;
  }
  res.json(row);
});

router.delete("/:id", requirePermission(Permission.LEAD_SOURCES_MANAGE), async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) {
    badRequest(res, "invalid_id");
    return;
  }
  await db.delete(leadSourcesTable).where(eq(leadSourcesTable.id, id));
  res.status(204).end();
});

export default router;
