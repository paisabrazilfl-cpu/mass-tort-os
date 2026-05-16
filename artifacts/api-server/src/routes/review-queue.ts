import { Router } from "express";
import { db, reviewQueueTable, pool } from "@workspace/db";
import { eq, and, sql, desc } from "drizzle-orm";
import { z } from "zod/v4";
import { auditLog } from "../lib/audit";
import { logger } from "../lib/logger";
import { Permission, requirePermission, auditAction } from "../lib/rbac";
import { badRequest, notFound, serverError } from "../lib/http-errors";
import { requireFirmId } from "../lib/firm-scope";
import { enqueueLeadFollowUpSms } from "../lib/workflow-engine";

const router = Router();

// Idempotent runtime repair: add firm_id to legacy deployments on first
// request. Cheap on subsequent calls (cached boolean). Postgres' ADD COLUMN
// IF NOT EXISTS guards re-runs.
let _firmIdPatched = false;
async function ensureFirmIdColumn(): Promise<void> {
  if (_firmIdPatched) return;
  try {
    await pool.query("ALTER TABLE review_queue ADD COLUMN IF NOT EXISTS firm_id integer");
    await pool.query("CREATE INDEX IF NOT EXISTS review_queue_firm_resolution_idx ON review_queue(firm_id, resolution, created_at)");
  } catch (err) {
    logger.warn({ err }, "review_queue firm_id schema repair partial — continuing");
  }
  _firmIdPatched = true;
}

// POST /api/review-queue — operator/automation enqueues an item for human
// review. Documented in the admin event catalog and used by the day-one
// n8n workflow `03-ocr-routing.json` to route low-confidence/failed OCR
// rows to a human. Gated by the same RESOLVE permission that already
// controls writes to this table.
const CreateReviewItemSchema = z.object({
  entity_type: z.string().min(1).max(50),
  entity_id: z.string().min(1).max(100),
  conflict_type: z.string().min(1).max(50).default("automation_routed"),
  severity: z.enum(["low", "medium", "high", "critical"]).default("medium"),
  failsafe_mode: z.enum(["queue", "block", "warn", "auto"]).default("queue"),
  source_module: z.string().min(1).max(100).default("automation"),
  summary: z.string().min(1).optional(),
  reason: z.string().min(1).optional(),
  context: z.record(z.string(), z.unknown()).optional(),
  details: z.record(z.string(), z.unknown()).optional(),
});

router.post(
  "/",
  requirePermission(Permission.REVIEW_QUEUE_RESOLVE),
  auditAction("create_review_item"),
  async (req, res) => {
    const parsed = CreateReviewItemSchema.safeParse(req.body);
    if (!parsed.success) {
      badRequest(res, "Invalid review-queue payload", parsed.error.issues);
      return;
    }
    const body = parsed.data;
    // n8n workflow #3 sends `reason` and `context`; the table stores them
    // as `summary` + `details`. Accept either shape so both legacy callers
    // and the documented automation contract work.
    const summary = body.summary ?? body.reason ?? `${body.entity_type}:${body.entity_id} routed for review`;
    const details = body.details ?? body.context ?? null;

    await ensureFirmIdColumn();
    // Stamp firm_id at insert time so the row is firm-owned from creation.
    // Falls back to null when a system automation creates an item with no
    // user context; those rows are intentionally visible to no firm until
    // an admin reassigns them.
    const insertFirmId = req.user?.firm_id ?? null;
    const [row] = await db
      .insert(reviewQueueTable)
      .values({
        firm_id: insertFirmId,
        entity_type: body.entity_type,
        entity_id: body.entity_id,
        conflict_type: body.conflict_type,
        severity: body.severity,
        failsafe_mode: body.failsafe_mode,
        source_module: body.source_module,
        summary,
        details,
      })
      .returning();

    await auditLog("review_queue", String(row.id), "created", {
      entity_type: row.entity_type,
      entity_id: row.entity_id,
      conflict_type: row.conflict_type,
      source_module: row.source_module,
      created_by: req.user?.email ?? "api_key",
    });

    res.status(201).json(row);
  },
);

router.get("/", requirePermission(Permission.REVIEW_QUEUE_VIEW), async (req, res) => {
  try {
    await ensureFirmIdColumn();
    const firmId = requireFirmId(req);
    const { resolution, conflict_type, severity, entity_type, limit } = req.query as Record<string, string | undefined>;

    // Firm scope is the FIRST predicate — every other filter rides on top.
    // Pre-fix, this list returned every firm's review items to any caller
    // with REVIEW_QUEUE_VIEW.
    const conditions = [eq(reviewQueueTable.firm_id, firmId)];
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

    const items = await db
      .select()
      .from(reviewQueueTable)
      .where(and(...conditions))
      .orderBy(desc(reviewQueueTable.created_at))
      .limit(cappedLimit);

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
  } catch (err: any) {
    logger.error({ err: err?.message }, "review-queue GET / failed");
    serverError(res, "Failed to list review items");
  }
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
  let firmId: number;
  try {
    await ensureFirmIdColumn();
    firmId = requireFirmId(req);
  } catch (err: any) {
    logger.error({ err: err?.message }, "review-queue /stats: firm-scope check failed");
    serverError(res, "Failed to load review stats");
    return;
  }
  const firmScope = eq(reviewQueueTable.firm_id, firmId);
  const [byResolution, byConflictType, bySeverity, byFailsafe, pendingBySeverity, resolvedTodayRow] =
    await Promise.all([
      db
        .select({
          resolution: reviewQueueTable.resolution,
          count: sql<number>`count(*)::int`,
        })
        .from(reviewQueueTable)
        .where(firmScope)
        .groupBy(reviewQueueTable.resolution),
      db
        .select({
          conflict_type: reviewQueueTable.conflict_type,
          count: sql<number>`count(*)::int`,
        })
        .from(reviewQueueTable)
        .where(firmScope)
        .groupBy(reviewQueueTable.conflict_type),
      db
        .select({
          severity: reviewQueueTable.severity,
          count: sql<number>`count(*)::int`,
        })
        .from(reviewQueueTable)
        .where(firmScope)
        .groupBy(reviewQueueTable.severity),
      db
        .select({
          failsafe_mode: reviewQueueTable.failsafe_mode,
          count: sql<number>`count(*)::int`,
        })
        .from(reviewQueueTable)
        .where(firmScope)
        .groupBy(reviewQueueTable.failsafe_mode),
      db
        .select({
          severity: reviewQueueTable.severity,
          count: sql<number>`count(*)::int`,
        })
        .from(reviewQueueTable)
        .where(and(firmScope, eq(reviewQueueTable.resolution, "pending")))
        .groupBy(reviewQueueTable.severity),
      db
        .select({ count: sql<number>`count(*)::int` })
        .from(reviewQueueTable)
        .where(
          and(firmScope, sql`${reviewQueueTable.resolution} <> 'pending' AND ${reviewQueueTable.resolved_at} >= current_date`),
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

  const { resolution, resolution_notes, followup_sms_body } = req.body as {
    resolution?: string;
    resolution_notes?: string;
    followup_sms_body?: string;
  };
  const resolved_by = req.user?.email || "unknown";

  if (!resolution || !["accepted", "rejected", "escalated"].includes(resolution)) {
    badRequest(res, "resolution must be one of: accepted, rejected, escalated");
    return;
  }

  let firmId: number;
  try {
    await ensureFirmIdColumn();
    firmId = requireFirmId(req);
  } catch (err: any) {
    logger.error({ err: err?.message, id }, "review-queue PATCH: firm-scope check failed");
    serverError(res, "Failed to resolve review item");
    return;
  }
  // Lookup AND update both gated by firm_id so an admin in firm A can't
  // resolve firm B's item by guessing the integer id.
  const [existing] = await db
    .select()
    .from(reviewQueueTable)
    .where(and(eq(reviewQueueTable.id, id), eq(reviewQueueTable.firm_id, firmId)));
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
    .where(and(eq(reviewQueueTable.id, id), eq(reviewQueueTable.firm_id, firmId)))
    .returning();

  // Optional SMS follow-up step (Task #51 T004): if the reviewer accepted a
  // lead-scoped item AND supplied a non-empty body, schedule a Telnyx SMS via
  // the workflow engine. We only fire on `accepted` for lead entities and
  // never on rejects/escalations to avoid contacting leads we just declined.
  let smsJobId: number | null = null;
  let smsReason: string | undefined;
  if (
    resolution === "accepted" &&
    existing.entity_type === "lead" &&
    typeof followup_sms_body === "string" &&
    followup_sms_body.trim().length > 0
  ) {
    const leadId = Number(existing.entity_id);
    if (Number.isFinite(leadId) && leadId > 0) {
      const result = await enqueueLeadFollowUpSms(leadId, followup_sms_body, {
        source: "review_queue_resolve",
        firmId: req.user?.firm_id ?? null,
      });
      smsJobId = result.job_id;
      smsReason = result.reason;
      if (!result.job_id) {
        logger.warn(
          { review_id: id, lead_id: leadId, reason: result.reason },
          "review-queue: follow-up SMS enqueue failed",
        );
      }
    }
  }

  await auditLog("review_queue", String(id), "resolved", {
    entity_type: existing.entity_type,
    entity_id: existing.entity_id,
    conflict_type: existing.conflict_type,
    resolution,
    resolution_notes,
    resolved_by: resolved_by || "admin",
    followup_sms_job_id: smsJobId,
    followup_sms_reason: smsReason ?? null,
  });

  logger.info(
    { review_id: id, resolution, entity: existing.entity_id, followup_sms_job_id: smsJobId },
    "Review item resolved",
  );

  res.json({ ...updated, followup_sms_job_id: smsJobId });
});

export default router;
