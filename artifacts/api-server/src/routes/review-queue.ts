import { Router } from "express";
import { db, reviewQueueTable } from "@workspace/db";
import { eq, and, sql, desc } from "drizzle-orm";
import { auditLog } from "../lib/audit";
import { logger } from "../lib/logger";
import { Permission, requirePermission, auditAction } from "../lib/rbac";
import { badRequest, notFound } from "../lib/http-errors";

const router = Router();

router.get("/", requirePermission(Permission.REVIEW_QUEUE_VIEW), async (req, res) => {
  const { resolution, conflict_type, severity, entity_type, limit } = req.query as Record<string, string | undefined>;

  const conditions = [];
  if (resolution) conditions.push(eq(reviewQueueTable.resolution, resolution));
  if (conflict_type) conditions.push(eq(reviewQueueTable.conflict_type, conflict_type));
  if (severity) conditions.push(eq(reviewQueueTable.severity, severity));
  if (entity_type) conditions.push(eq(reviewQueueTable.entity_type, entity_type));

  // Hard cap to keep this endpoint consistent with the other paginated lists
  // (default 100, max 500) — without this an attacker could request
  // ?limit=10000000 and force a massive scan. Strict integer parsing so
  // values like "1.5" or "abc" fall back to the default rather than being
  // silently coerced into surprising query plans.
  const parsedLimit = limit === undefined ? NaN : parseInt(limit, 10);
  const cappedLimit =
    Number.isInteger(parsedLimit) && parsedLimit > 0
      ? Math.min(parsedLimit, 500)
      : 100;

  const items = conditions.length > 0
    ? await db.select().from(reviewQueueTable).where(and(...conditions)).orderBy(desc(reviewQueueTable.created_at)).limit(cappedLimit)
    : await db.select().from(reviewQueueTable).orderBy(desc(reviewQueueTable.created_at)).limit(cappedLimit);

  // Defensive: `details` is jsonb so a legacy or hand-edited row could store a
  // primitive (string/number) or an array instead of a plain object. The
  // previous code assumed object shape and would crash with
  //   "TypeError: Cannot destructure property 'original_input' of 'details'"
  // when `details` was a non-null primitive. Guard explicitly.
  const sanitized = items.map((item) => {
    const details = item.details;
    if (
      details &&
      typeof details === "object" &&
      !Array.isArray(details)
    ) {
      const { original_input, ...safe } = details as Record<string, unknown>;
      return { ...item, details: safe };
    }
    // Non-object details (legacy, primitive, or array): expose as-is so the
    // operator can still see the bad value rather than silently dropping it.
    return item;
  });

  res.json(sanitized);
});

router.get("/stats", requirePermission(Permission.REVIEW_QUEUE_VIEW), async (req, res) => {
  // The dashboard cards live next to "Pending Review" so operators read them
  // as "what currently needs attention". Counting all-time critical/high
  // (including resolved) is the same kind of misleading display we just
  // removed from the security alerts table: a card that visually screams
  // "act now" while actually summing historical work. Same logic applies to
  // "Resolved Today" — that label promises a daily figure, so the count must
  // be scoped to today's resolved_at timestamps, not "every non-pending row
  // since the table was created".
  const [byResolution, byConflictType, bySeverity, byFailsafe, pendingBySeverity, resolvedTodayRow] =
    await Promise.all([
      db
        .select({
          resolution: reviewQueueTable.resolution,
          count: sql<number>`count(*)::int`,
        })
        .from(reviewQueueTable)
        .groupBy(reviewQueueTable.resolution),
      db
        .select({
          conflict_type: reviewQueueTable.conflict_type,
          count: sql<number>`count(*)::int`,
        })
        .from(reviewQueueTable)
        .groupBy(reviewQueueTable.conflict_type),
      db
        .select({
          severity: reviewQueueTable.severity,
          count: sql<number>`count(*)::int`,
        })
        .from(reviewQueueTable)
        .groupBy(reviewQueueTable.severity),
      db
        .select({
          failsafe_mode: reviewQueueTable.failsafe_mode,
          count: sql<number>`count(*)::int`,
        })
        .from(reviewQueueTable)
        .groupBy(reviewQueueTable.failsafe_mode),
      db
        .select({
          severity: reviewQueueTable.severity,
          count: sql<number>`count(*)::int`,
        })
        .from(reviewQueueTable)
        .where(eq(reviewQueueTable.resolution, "pending"))
        .groupBy(reviewQueueTable.severity),
      db
        .select({ count: sql<number>`count(*)::int` })
        .from(reviewQueueTable)
        .where(
          sql`${reviewQueueTable.resolution} <> 'pending' AND ${reviewQueueTable.resolved_at} >= current_date`,
        ),
    ]);

  const totalPending = byResolution.find((r) => r.resolution === "pending")?.count || 0;
  const pendingCritical = pendingBySeverity.find((r) => r.severity === "critical")?.count || 0;
  const pendingHigh = pendingBySeverity.find((r) => r.severity === "high")?.count || 0;
  const resolvedToday = resolvedTodayRow[0]?.count || 0;

  res.json({
    total_pending: totalPending,
    pending_critical: pendingCritical,
    pending_high: pendingHigh,
    resolved_today: resolvedToday,
    by_resolution: byResolution,
    by_conflict_type: byConflictType,
    by_severity: bySeverity,
    by_failsafe_mode: byFailsafe,
  });
});

router.patch("/:id", requirePermission(Permission.REVIEW_QUEUE_RESOLVE), auditAction("resolve_review_item"), async (req, res) => {
  const id = Number(req.params.id);
  if (isNaN(id)) {
    badRequest(res, "Invalid ID");
    return;
  }

  const { resolution, resolution_notes } = req.body as {
    resolution?: string;
    resolution_notes?: string;
  };
  const resolved_by = req.user?.email || "unknown";

  if (!resolution || !["accepted", "rejected", "escalated"].includes(resolution)) {
    badRequest(res, "resolution must be one of: accepted, rejected, escalated");
    return;
  }

  const [existing] = await db.select().from(reviewQueueTable).where(eq(reviewQueueTable.id, id));
  if (!existing) {
    notFound(res, "Review item not found");
    return;
  }

  const [updated] = await db
    .update(reviewQueueTable)
    .set({
      resolution,
      resolution_notes: resolution_notes || null,
      resolved_by,
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
