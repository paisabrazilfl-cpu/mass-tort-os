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
import { desc, eq, sql, and, or, ilike, gte, lte } from "drizzle-orm";
import { requirePermission, Permission } from "../lib/rbac";
import { badRequest } from "../lib/http-errors";
import { getFirmIdForUser } from "../lib/subscription-gate";
import { resolveProvider, isResolved } from "../lib/provider-router";
import { getVoiceAdapter } from "../lib/voice";
import { buildLeadCallContext } from "../lib/voice/lead-call-context";
import { logger } from "../lib/logger";

/**
 * Firm scoping: every operator request must be filtered by their
 * firm_id. The dev-bypass user (id=0) has no firm row — for that
 * single account we fall back to "no scope" so local development
 * with dev-login keeps working. Real users without a firm get a
 * 403 because that's a misconfiguration, not a permission gap.
 */
async function resolveFirmScope(
  userId: number,
): Promise<{ firmId: number | null; error?: { status: number; code: string; message: string } }> {
  if (userId <= 0) return { firmId: null }; // dev bypass — see header.
  const firmId = await getFirmIdForUser(userId);
  if (!firmId) {
    return {
      firmId: null,
      error: {
        status: 403,
        code: "NO_FIRM",
        message: "User account is not linked to a firm.",
      },
    };
  }
  return { firmId };
}

const router = Router();

// start_date / end_date are inclusive ISO-8601 timestamps applied to
// call_logs.started_at. They're independent — operators can pass one
// without the other (open-ended ranges). Invalid dates fail the schema
// with a 400 instead of silently dropping the filter.
const listQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  page_size: z.coerce.number().int().min(1).max(100).default(25),
  status: z
    .enum(["queued", "in_progress", "completed", "failed", "no_answer"])
    .optional(),
  lead_id: z.coerce.number().int().positive().optional(),
  search: z.string().trim().min(1).max(60).optional(),
  start_date: z.coerce.date().optional(),
  end_date: z.coerce.date().optional(),
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
    const { page, page_size, status, lead_id, search, start_date, end_date } = parsed.data;
    const offset = (page - 1) * page_size;

    const scope = await resolveFirmScope(req.user!.id);
    if (scope.error) {
      res.status(scope.error.status).json({
        status: "error",
        code: scope.error.code,
        message: scope.error.message,
      });
      return;
    }

    const conds = [];
    if (scope.firmId !== null) {
      conds.push(eq(callLogsTable.firm_id, scope.firmId));
    }
    if (status) conds.push(eq(callLogsTable.status, status));
    if (lead_id) conds.push(eq(callLogsTable.lead_id, lead_id));
    if (start_date) conds.push(gte(callLogsTable.started_at, start_date));
    if (end_date) conds.push(lte(callLogsTable.started_at, end_date));
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

    const scope = await resolveFirmScope(req.user!.id);
    if (scope.error) {
      res.status(scope.error.status).json({
        status: "error",
        code: scope.error.code,
        message: scope.error.message,
      });
      return;
    }

    // Firm scope is folded into the WHERE so a cross-firm id returns
    // 404, not 200 — leaking row existence across firms would itself
    // be a data exposure.
    const idCond = eq(callLogsTable.id, id);
    const where =
      scope.firmId !== null ? and(idCond, eq(callLogsTable.firm_id, scope.firmId)) : idCond;

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
      .where(where)
      .limit(1);
    const row = rows[0];
    if (!row) {
      res.status(404).json({ status: "error", code: "NOT_FOUND", message: "Call not found" });
      return;
    }

    res.json({ status: "ok", data: row });
  },
);

/**
 * POST /api/calls/outbound — kick off an outbound voice call through
 * the operator-chosen voice provider (Workflow Settings → Voice
 * Provider). Resolves through provider-router so the same call surface
 * works for vapi/retell_ai/bland_ai/elevenlabs/synthflow without any
 * caller branching. Persists a queued call_logs row up front so the
 * Calls page reflects the attempt even if the provider rejects it.
 */
const OutboundCallBody = z.object({
  to: z.string().min(7),
  assistant_id: z.string().min(1),
  lead_id: z.number().int().optional(),
  from: z.string().min(7).optional(),
  context: z.record(z.string(), z.string()).optional(),
});

router.post(
  "/outbound",
  requirePermission(Permission.CALLS_MANAGE),
  async (req, res) => {
    const parsed = OutboundCallBody.safeParse(req.body);
    if (!parsed.success) {
      badRequest(res, "Invalid outbound call body", parsed.error.issues);
      return;
    }
    const { to, assistant_id, lead_id, from, context } = parsed.data;

    const user = req.user!;
    const scope = await resolveFirmScope(user.id);
    if (scope.error) {
      res.status(scope.error.status).json({ status: "error", code: scope.error.code, message: scope.error.message });
      return;
    }

    const resolved = await resolveProvider("voice");
    if (!isResolved(resolved)) {
      res.status(503).json({
        status: "error",
        code: "VOICE_PROVIDER_UNAVAILABLE",
        message: `Voice provider not available: ${resolved.reason} — ${resolved.details ?? ""}`,
      });
      return;
    }

    const adapter = getVoiceAdapter(resolved.provider);
    if (!adapter?.startCall) {
      res.status(503).json({
        status: "error",
        code: "VOICE_PROVIDER_NOT_IMPLEMENTED",
        message: `Voice provider "${resolved.provider}" does not implement outbound startCall.`,
      });
      return;
    }

    // Outbound enrichment: when a lead is attached, load + decrypt the full
    // record and hand the agent everything we know (name, contact, tort,
    // captured intake) so it greets by name and confirms rather than
    // re-asking. Caller-supplied context wins on key collisions. Failures
    // here must never block the call — the agent simply falls back to a
    // cold intake.
    let callContext: Record<string, string> = { ...(context ?? {}) };
    let leadTortType: string | null = null;
    if (lead_id != null) {
      try {
        const leadCtx = await buildLeadCallContext(lead_id, scope.firmId);
        if (leadCtx) {
          callContext = {
            caller_context: leadCtx.summary,
            ...leadCtx.variableValues,
            ...callContext,
          };
          leadTortType = leadCtx.tortType;
        }
      } catch (err) {
        logger.warn({ err, lead_id }, "outbound: failed to build lead call context; proceeding cold");
      }
    }

    // Persist the queued row before dispatch so an upstream timeout
    // still leaves an audit trail visible to the operator.
    const [inserted] = await db
      .insert(callLogsTable)
      .values({
        firm_id: scope.firmId,
        lead_id: lead_id ?? null,
        direction: "outbound",
        from_number: from ?? null,
        to_number: to,
        status: "queued",
        vapi_assistant_id: resolved.provider === "vapi" ? assistant_id : null,
        tort_type: leadTortType,
      })
      .returning({ id: callLogsTable.id });
    const callLogId = inserted!.id;

    try {
      const out = await adapter.startCall(resolved.credentials, {
        assistantId: assistant_id,
        to,
        from,
        context: callContext,
        metadata: {
          call_log_id: String(callLogId),
          lead_id: lead_id != null ? String(lead_id) : "",
          ...(leadTortType ? { tort_id: leadTortType } : {}),
        },
      });

      if (!out.ok) {
        await db
          .update(callLogsTable)
          .set({ status: "failed", error: out.message, updated_at: new Date() })
          .where(eq(callLogsTable.id, callLogId));
        res.status(502).json({
          status: "error",
          code: "VOICE_START_FAILED",
          message: out.message,
          provider: resolved.provider,
          call_log_id: callLogId,
        });
        return;
      }

      // External id naming varies; we keep vapi_call_id for vapi for
      // backwards-compat with the existing webhook lookup, and stash
      // every other provider's id in the events log so it's still
      // discoverable from the call detail view.
      const updates: Record<string, unknown> = {
        status: "ringing",
        started_at: new Date(),
        updated_at: new Date(),
      };
      if (resolved.provider === "vapi") updates.vapi_call_id = out.externalCallId;
      else {
        updates.events = sql`${callLogsTable.events} || ${JSON.stringify([
          { kind: "outbound_started", provider: resolved.provider, external_call_id: out.externalCallId, ts: new Date().toISOString() },
        ])}::jsonb`;
      }
      await db.update(callLogsTable).set(updates).where(eq(callLogsTable.id, callLogId));

      res.json({
        status: "ok",
        data: {
          call_log_id: callLogId,
          provider: resolved.provider,
          external_call_id: out.externalCallId,
        },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      logger.error({ err, callLogId, provider: resolved.provider }, "outbound voice call threw");
      await db
        .update(callLogsTable)
        .set({ status: "failed", error: message, updated_at: new Date() })
        .where(eq(callLogsTable.id, callLogId));
      res.status(500).json({
        status: "error",
        code: "VOICE_START_THREW",
        message,
        provider: resolved.provider,
        call_log_id: callLogId,
      });
    }
  },
);

export default router;
