import { Router } from "express";
import { db, reviewQueueTable } from "@workspace/db";
import { eq, and, sql, desc } from "drizzle-orm";
import { auditLog } from "../lib/audit";
import { logger } from "../lib/logger";

const router = Router();

router.get("/", async (req, res) => {
  const { resolution, conflict_type, severity, entity_type, limit } = req.query as Record<string, string | undefined>;

  const conditions = [];
  if (resolution) conditions.push(eq(reviewQueueTable.resolution, resolution));
  if (conflict_type) conditions.push(eq(reviewQueueTable.conflict_type, conflict_type));
  if (severity) conditions.push(eq(reviewQueueTable.severity, severity));
  if (entity_type) conditions.push(eq(reviewQueueTable.entity_type, entity_type));

  const items = conditions.length > 0
    ? await db.select().from(reviewQueueTable).where(and(...conditions)).orderBy(desc(reviewQueueTable.created_at)).limit(Number(limit) || 100)
    : await db.select().from(reviewQueueTable).orderBy(desc(reviewQueueTable.created_at)).limit(Number(limit) || 100);

  const sanitized = items.map((item) => {
    const details = item.details as Record<string, unknown> | null;
    if (details) {
      const { original_input, ...safe } = details;
      return { ...item, details: safe };
    }
    return item;
  });

  res.json(sanitized);
});

router.get("/stats", async (req, res) => {
  const byResolution = await db
    .select({
      resolution: reviewQueueTable.resolution,
      count: sql<number>`count(*)::int`,
    })
    .from(reviewQueueTable)
    .groupBy(reviewQueueTable.resolution);

  const byConflictType = await db
    .select({
      conflict_type: reviewQueueTable.conflict_type,
      count: sql<number>`count(*)::int`,
    })
    .from(reviewQueueTable)
    .groupBy(reviewQueueTable.conflict_type);

  const bySeverity = await db
    .select({
      severity: reviewQueueTable.severity,
      count: sql<number>`count(*)::int`,
    })
    .from(reviewQueueTable)
    .groupBy(reviewQueueTable.severity);

  const byFailsafe = await db
    .select({
      failsafe_mode: reviewQueueTable.failsafe_mode,
      count: sql<number>`count(*)::int`,
    })
    .from(reviewQueueTable)
    .groupBy(reviewQueueTable.failsafe_mode);

  const totalPending = byResolution.find((r) => r.resolution === "pending")?.count || 0;

  res.json({
    total_pending: totalPending,
    by_resolution: byResolution,
    by_conflict_type: byConflictType,
    by_severity: bySeverity,
    by_failsafe_mode: byFailsafe,
  });
});

router.patch("/:id", async (req, res) => {
  const id = Number(req.params.id);
  if (isNaN(id)) {
    res.status(400).json({ error: "Invalid ID" });
    return;
  }

  const { resolution, resolution_notes, resolved_by } = req.body as {
    resolution?: string;
    resolution_notes?: string;
    resolved_by?: string;
  };

  if (!resolution || !["accepted", "rejected", "escalated"].includes(resolution)) {
    res.status(400).json({ error: "resolution must be one of: accepted, rejected, escalated" });
    return;
  }

  const [existing] = await db.select().from(reviewQueueTable).where(eq(reviewQueueTable.id, id));
  if (!existing) {
    res.status(404).json({ error: "Review item not found" });
    return;
  }

  const [updated] = await db
    .update(reviewQueueTable)
    .set({
      resolution,
      resolution_notes: resolution_notes || null,
      resolved_by: resolved_by || "admin",
      resolved_at: new Date(),
    })
    .where(eq(reviewQueueTable.id, id))
    .returning();

  await auditLog("review_queue", String(id), "resolved", {
    entity_type: existing.entity_type,
    entity_id: existing.entity_id,
    conflict_type: existing.conflict_type,
    resolution,
    resolution_notes,
    resolved_by: resolved_by || "admin",
  });

  logger.info({ review_id: id, resolution, entity: existing.entity_id }, "Review item resolved");

  res.json(updated);
});

export default router;
