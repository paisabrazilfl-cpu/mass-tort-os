/**
 * Calls routes — operator-facing read-only views over call_logs.
 *
 * The actual call ingestion happens in routes/webhooks.ts (POST /vapi)
 * which receives provider events asynchronously. This router exposes
 * a paginated list and a single-row detail with transcript + intake
 * result so the Calls page can render them.
 *
 * Both endpoints require Permission.CALLS_VIEW. There is no write
 * surface here on purpose — operators do not patch call rows, the
 * webhook is the source of truth.
 */
import { Router } from "express";
import { z } from "zod/v4";
import { db, callLogsTable, leadsTable } from "@workspace/db";
import { desc, eq, sql, and, or, ilike } from "drizzle-orm";
import { requirePermission, Permission } from "../lib/rbac";
import { badRequest } from "../lib/http-errors";

const router = Router();

const listQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  page_size: z.coerce.number().int().min(1).max(100).default(25),
  status: z
    .enum(["queued", "in_progress", "completed", "failed", "no_answer"])
    .optional(),
  lead_id: z.coerce.number().int().positive().optional(),
  search: z.string().trim().min(1).max(60).optional(),
});

router.get(
  "/",
  requirePermission(Permission.CALLS_VIEW),
  async (req, res) => {
    const parsed = listQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      badRequest(res, "Invalid query", parsed.error.issues);
      return;
    }
    const { page, page_size, status, lead_id, search } = parsed.data;
    const offset = (page - 1) * page_size;

    const conds = [];
    if (status) conds.push(eq(callLogsTable.status, status));
    if (lead_id) conds.push(eq(callLogsTable.lead_id, lead_id));
    if (search) {
      conds.push(
        or(
          ilike(callLogsTable.from_number, `%${search}%`),
          ilike(callLogsTable.to_number, `%${search}%`),
          ilike(callLogsTable.vapi_call_id, `%${search}%`),
        )!,
      );
    }
    const where = conds.length > 0 ? and(...conds) : undefined;

    const [rows, totalRows] = await Promise.all([
      db
        .select({
          id: callLogsTable.id,
          firm_id: callLogsTable.firm_id,
          lead_id: callLogsTable.lead_id,
          vapi_call_id: callLogsTable.vapi_call_id,
          direction: callLogsTable.direction,
          from_number: callLogsTable.from_number,
          to_number: callLogsTable.to_number,
          status: callLogsTable.status,
          started_at: callLogsTable.started_at,
          ended_at: callLogsTable.ended_at,
          duration_seconds: callLogsTable.duration_seconds,
          recording_url: callLogsTable.recording_url,
          created_at: callLogsTable.created_at,
        })
        .from(callLogsTable)
        .where(where)
        .orderBy(desc(callLogsTable.created_at))
        .limit(page_size)
        .offset(offset),
      db
        .select({ count: sql<number>`count(*)::int` })
        .from(callLogsTable)
        .where(where),
    ]);

    res.json({
      status: "ok",
      data: {
        rows,
        page,
        page_size,
        total: totalRows[0]?.count ?? 0,
      },
    });
  },
);

const idParamSchema = z.object({ id: z.coerce.number().int().positive() });

router.get(
  "/:id",
  requirePermission(Permission.CALLS_VIEW),
  async (req, res) => {
    const parsed = idParamSchema.safeParse(req.params);
    if (!parsed.success) {
      badRequest(res, "Invalid id", parsed.error.issues);
      return;
    }
    const { id } = parsed.data;

    const rows = await db
      .select({
        id: callLogsTable.id,
        firm_id: callLogsTable.firm_id,
        lead_id: callLogsTable.lead_id,
        lead_first_name: leadsTable.first_name,
        lead_last_name: leadsTable.last_name,
        vapi_call_id: callLogsTable.vapi_call_id,
        direction: callLogsTable.direction,
        from_number: callLogsTable.from_number,
        to_number: callLogsTable.to_number,
        status: callLogsTable.status,
        started_at: callLogsTable.started_at,
        ended_at: callLogsTable.ended_at,
        duration_seconds: callLogsTable.duration_seconds,
        recording_url: callLogsTable.recording_url,
        transcript: callLogsTable.transcript,
        intake_result: callLogsTable.intake_result,
        events: callLogsTable.events,
        error: callLogsTable.error,
        created_at: callLogsTable.created_at,
        updated_at: callLogsTable.updated_at,
      })
      .from(callLogsTable)
      .leftJoin(leadsTable, eq(callLogsTable.lead_id, leadsTable.id))
      .where(eq(callLogsTable.id, id))
      .limit(1);
    const row = rows[0];
    if (!row) {
      res.status(404).json({ status: "error", code: "NOT_FOUND", message: "Call not found" });
      return;
    }

    res.json({ status: "ok", data: row });
  },
);

export default router;
