/**
 * Self-Heal / Auto-Fix routes (mounted at /api/admin/self-heal).
 *
 * Operator pastes an error message or feature request → we dispatch it
 * to the Jules coding agent against the configured GitHub source. Jules
 * writes the fix and (by default) opens a PR. The operator merges in
 * GitHub — per the AI Constitution we never auto-merge code.
 *
 * Endpoints:
 *   GET    /                    list this firm's recent sessions
 *   POST   /                    create a new session (dispatches to Jules)
 *   GET    /config              { configured, default_source }
 *   GET    /:id                 row + live Jules session + last activities
 *   POST   /:id/messages        send a follow-up message to the agent
 *   POST   /:id/approve         approve the latest plan (if requirePlanApproval)
 *   POST   /:id/refresh         re-pull from Jules and update local row
 *
 * RBAC: every route requires `self_heal:manage` (admin only).
 * Audit: every mutation lands in audit_log.
 */
import { Router, type Request } from "express";
import { z } from "zod";
import { and, desc, eq } from "drizzle-orm";
import { db, pool, selfHealSessionsTable } from "@workspace/db";
import { Permission, requirePermission } from "../lib/rbac";
import { auditLog } from "../lib/audit";
import { badRequest, notFound } from "../lib/http-errors";
import {
  createSession as julesCreateSession,
  getSession as julesGetSession,
  listActivities as julesListActivities,
  sendMessage as julesSendMessage,
  approvePlan as julesApprovePlan,
  getDefaultSourceName,
  isJulesConfigured,
  JulesError,
  type JulesSession,
} from "../lib/jules-client";

const router = Router();

const CreateBody = z.object({
  prompt: z.string().trim().min(10, "Paste a real message — at least 10 characters.").max(20_000),
  title: z.string().trim().min(1).max(200).optional(),
  source_name: z.string().trim().min(1).max(300).optional(),
  starting_branch: z.string().trim().min(1).max(120).optional(),
  automation_mode: z.enum(["AUTO_CREATE_PR", "MANUAL"]).optional(),
  require_plan_approval: z.boolean().optional(),
});

const IdParam = z.object({ id: z.coerce.number().int().positive() });
const MessageBody = z.object({ prompt: z.string().trim().min(1).max(20_000) });

function deriveStatus(session: JulesSession | null, prior: string): string {
  if (!session) return prior;
  const pr = session.outputs?.find((o) => o.pullRequest)?.pullRequest;
  if (pr?.url) return "completed";
  return prior === "pending" ? "dispatched" : prior;
}

function deriveTitle(prompt: string): string {
  const firstLine = prompt.trim().split("\n")[0]?.trim() ?? "";
  return firstLine.length > 80 ? firstLine.slice(0, 77) + "..." : firstLine || "Self-Heal session";
}

router.get("/config", requirePermission(Permission.SELF_HEAL_MANAGE), async (_req, res) => {
  res.json({
    configured: isJulesConfigured(),
    default_source: await getDefaultSourceName(),
  });
});

router.get("/", requirePermission(Permission.SELF_HEAL_MANAGE), async (req, res) => {
  try {
    const firmId = (req as any).user?.firm_id ?? (req as any).firmId;
    const where = firmId != null ? "firm_id = " + Number(firmId) : "1=1";
    const raw = await pool.query(
      "SELECT * FROM self_heal_sessions WHERE " + where + " ORDER BY created_at DESC LIMIT 50"
    );
    res.json({ sessions: raw.rows ?? [] });
  } catch (err: any) {
    res.json({ sessions: [] });
  }
});

router.post("/", requirePermission(Permission.SELF_HEAL_MANAGE), async (req, res) => {
  const parsed = CreateBody.safeParse(req.body);
  if (!parsed.success) return badRequest(res, "Invalid input", parsed.error.flatten());
  if (!isJulesConfigured()) {
    return res.status(503).json({
      status: "error",
      code: "jules_not_configured",
      message: "JULES_API_KEY is not set. Add it in Secrets to enable Self-Heal.",
    });
  }

  const sourceName = parsed.data.source_name || await getDefaultSourceName();
  if (!sourceName) {
    return badRequest(res, "No Jules source configured. Set JULES_DEFAULT_SOURCE or pass source_name.");
  }

  const title = parsed.data.title || deriveTitle(parsed.data.prompt);
  const startingBranch = parsed.data.starting_branch || "main";
  const automationMode = parsed.data.automation_mode ?? "AUTO_CREATE_PR";
  const requirePlanApproval = parsed.data.require_plan_approval ?? false;

  // Insert local row up-front so we have a stable id even if Jules call fails.
  const [row] = await db
    .insert(selfHealSessionsTable)
    .values({
      firm_id: req.user!.firm_id,
      created_by_user_id: req.user!.id,
      source_name: sourceName,
      starting_branch: startingBranch,
      title,
      prompt: parsed.data.prompt,
      automation_mode: automationMode,
      require_plan_approval: requirePlanApproval,
      status: "pending",
    })
    .returning();

  try {
    const session = await julesCreateSession({
      prompt: parsed.data.prompt,
      sourceName,
      startingBranch,
      automationMode,
      requirePlanApproval,
      title,
    });
    const [updated] = await db
      .update(selfHealSessionsTable)
      .set({
        jules_session_id: session.id,
        jules_session_name: session.name,
        status: requirePlanApproval ? "awaiting_approval" : "dispatched",
        last_synced_at: new Date(),
        updated_at: new Date(),
      })
      .where(eq(selfHealSessionsTable.id, row.id))
      .returning();

    await auditLog("self_heal_session", String(row.id), "created", {
      firm_id: req.user!.firm_id,
      created_by_user_id: req.user!.id,
      jules_session_id: session.id,
      source_name: sourceName,
      starting_branch: startingBranch,
      automation_mode: automationMode,
      require_plan_approval: requirePlanApproval,
      title,
    });
    return res.status(201).json({ session: updated });
  } catch (err) {
    const ju = err instanceof JulesError ? err : null;
    const errorMsg = ju ? `${ju.status}: ${ju.message}` : (err as Error).message;
    await db
      .update(selfHealSessionsTable)
      .set({ status: "failed", last_error: errorMsg, updated_at: new Date() })
      .where(eq(selfHealSessionsTable.id, row.id));
    await auditLog("self_heal_session", String(row.id), "dispatch_failed", {
      firm_id: req.user!.firm_id,
      error: errorMsg,
    });
    return res.status(ju?.status === 503 ? 503 : 502).json({
      status: "error",
      code: "jules_dispatch_failed",
      message: errorMsg,
      session_id: row.id,
    });
  }
});

async function loadOwnedRow(req: Request, id: number) {
  const [row] = await db
    .select()
    .from(selfHealSessionsTable)
    .where(and(eq(selfHealSessionsTable.id, id), eq(selfHealSessionsTable.firm_id, req.user!.firm_id)));
  return row ?? null;
}

router.get("/:id", requirePermission(Permission.SELF_HEAL_MANAGE), async (req, res) => {
  const parsed = IdParam.safeParse(req.params);
  if (!parsed.success) return badRequest(res, "Invalid id");
  const row = await loadOwnedRow(req, parsed.data.id);
  if (!row) return notFound(res, "Session not found");

  let liveSession: JulesSession | null = null;
  let activities: unknown[] = [];
  let liveError: string | null = null;
  if (row.jules_session_id) {
    try {
      liveSession = await julesGetSession(row.jules_session_id);
      const acts = await julesListActivities(row.jules_session_id, 30);
      activities = acts.activities ?? [];
    } catch (err) {
      liveError = (err as Error).message;
    }
  }

  // Best-effort sync of status + PR url back into our row. Audit only
  // on real state transitions so 12s polling doesn't spam audit_log.
  let synced = row;
  if (liveSession) {
    const pr = liveSession.outputs?.find((o) => o.pullRequest)?.pullRequest;
    const newStatus = deriveStatus(liveSession, row.status);
    const prChanged = (pr?.url ?? null) !== row.pr_url;
    const statusChanged = newStatus !== row.status;
    if (prChanged || statusChanged) {
      const [updated] = await db
        .update(selfHealSessionsTable)
        .set({
          pr_url: pr?.url ?? row.pr_url,
          pr_title: pr?.title ?? row.pr_title,
          status: newStatus,
          last_synced_at: new Date(),
          updated_at: new Date(),
        })
        .where(eq(selfHealSessionsTable.id, row.id))
        .returning();
      synced = updated ?? row;
      await auditLog("self_heal_session", String(row.id), "synced", {
        firm_id: req.user!.firm_id,
        triggered_by: "get",
        old_status: row.status,
        new_status: newStatus,
        old_pr_url: row.pr_url,
        new_pr_url: pr?.url ?? null,
      });
    }
  }

  res.json({ session: synced, live: liveSession, activities, live_error: liveError });
});

router.post("/:id/messages", requirePermission(Permission.SELF_HEAL_MANAGE), async (req, res) => {
  const parsed = IdParam.safeParse(req.params);
  if (!parsed.success) return badRequest(res, "Invalid id");
  const body = MessageBody.safeParse(req.body);
  if (!body.success) return badRequest(res, "Invalid input", body.error.flatten());
  const row = await loadOwnedRow(req, parsed.data.id);
  if (!row) return notFound(res, "Session not found");
  if (!row.jules_session_id) return badRequest(res, "Session was never dispatched to Jules");

  try {
    await julesSendMessage(row.jules_session_id, body.data.prompt);
    await auditLog("self_heal_session", String(row.id), "message_sent", {
      firm_id: req.user!.firm_id,
      sent_by_user_id: req.user!.id,
      length: body.data.prompt.length,
    });
    res.status(204).end();
  } catch (err) {
    const ju = err instanceof JulesError ? err : null;
    res.status(ju?.status ?? 502).json({
      status: "error",
      code: "jules_send_message_failed",
      message: (err as Error).message,
    });
  }
});

router.post("/:id/approve", requirePermission(Permission.SELF_HEAL_MANAGE), async (req, res) => {
  const parsed = IdParam.safeParse(req.params);
  if (!parsed.success) return badRequest(res, "Invalid id");
  const row = await loadOwnedRow(req, parsed.data.id);
  if (!row) return notFound(res, "Session not found");
  if (!row.jules_session_id) return badRequest(res, "Session was never dispatched to Jules");

  try {
    await julesApprovePlan(row.jules_session_id);
    await db
      .update(selfHealSessionsTable)
      .set({ status: "dispatched", updated_at: new Date() })
      .where(eq(selfHealSessionsTable.id, row.id));
    await auditLog("self_heal_session", String(row.id), "plan_approved", {
      firm_id: req.user!.firm_id,
      approved_by_user_id: req.user!.id,
    });
    res.status(204).end();
  } catch (err) {
    const ju = err instanceof JulesError ? err : null;
    res.status(ju?.status ?? 502).json({
      status: "error",
      code: "jules_approve_plan_failed",
      message: (err as Error).message,
    });
  }
});

router.post("/:id/refresh", requirePermission(Permission.SELF_HEAL_MANAGE), async (req, res) => {
  const parsed = IdParam.safeParse(req.params);
  if (!parsed.success) return badRequest(res, "Invalid id");
  const row = await loadOwnedRow(req, parsed.data.id);
  if (!row) return notFound(res, "Session not found");
  if (!row.jules_session_id) {
    return res.json({ session: row, live: null, refreshed: false });
  }

  try {
    const live = await julesGetSession(row.jules_session_id);
    const pr = live.outputs?.find((o) => o.pullRequest)?.pullRequest;
    const newStatus = deriveStatus(live, row.status);
    const prChanged = (pr?.url ?? null) !== row.pr_url;
    const statusChanged = newStatus !== row.status;
    const [updated] = await db
      .update(selfHealSessionsTable)
      .set({
        pr_url: pr?.url ?? row.pr_url,
        pr_title: pr?.title ?? row.pr_title,
        status: newStatus,
        last_synced_at: new Date(),
        updated_at: new Date(),
      })
      .where(eq(selfHealSessionsTable.id, row.id))
      .returning();
    if (prChanged || statusChanged) {
      await auditLog("self_heal_session", String(row.id), "synced", {
        firm_id: req.user!.firm_id,
        triggered_by: "refresh",
        triggered_by_user_id: req.user!.id,
        old_status: row.status,
        new_status: newStatus,
        old_pr_url: row.pr_url,
        new_pr_url: pr?.url ?? null,
      });
    }
    res.json({ session: updated, live, refreshed: true });
  } catch (err) {
    const ju = err instanceof JulesError ? err : null;
    res.status(ju?.status ?? 502).json({
      status: "error",
      code: "jules_refresh_failed",
      message: (err as Error).message,
    });
  }
});

export default router;
