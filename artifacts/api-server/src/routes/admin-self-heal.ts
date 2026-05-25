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
import { db, selfHealSessionsTable } from "@workspace/db";
import { Permission, requirePermission } from "../lib/rbac";
import { auditLog } from "../lib/audit";
import { badRequest, notFound } from "../lib/http-errors";
import { logger } from "../lib/logger";
import { requireFirmId } from "../lib/firm-scope";
import {
  createSession as julesCreateSession,
  getSession as julesGetSession,
  listActivities as julesListActivities,
  sendMessage as julesSendMessage,
  approvePlan as julesApprovePlan,
  cancelSession as julesCancelSession,
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
  // Parameterized Drizzle query replaces the previous raw `pool.query` that
  // string-concatenated firm_id into the WHERE clause and fell back to `1=1`
  // when the JWT lacked a firm claim — which returned every firm's sessions
  // to whoever managed to slip in with an unscoped token. requireFirmId()
  // is the new contract: missing/invalid claim → 500 via the middleware
  // chain's error boundary, never a silent cross-tenant read.
  const firmId = requireFirmId(req);
  try {
    const sessions = await db
      .select()
      .from(selfHealSessionsTable)
      .where(eq(selfHealSessionsTable.firm_id, firmId))
      .orderBy(desc(selfHealSessionsTable.created_at))
      .limit(50);
    res.json({ sessions });
  } catch (err) {
    // Surface the failure rather than masking it as `{sessions: []}` — an
    // empty array previously made it impossible to distinguish "no work"
    // from "decryption or DB exploded". A 500 trips alerting and an empty
    // result keeps rendering for the operator's last good state.
    logger.error({ err, firm_id: firmId }, "admin/self-heal: list query failed");
    res.status(500).json({
      status: "error",
      code: "self_heal_list_failed",
      message: "Failed to list self-heal sessions",
    });
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

  // Prepend a codebase-scope header to every dispatched prompt. Jules
  // already has full read access to every file in the repo via its
  // GitHub App grant on `source_name` — but the agent doesn't know the
  // repo layout until it greps. This header gives it the map up front so
  // it spends less budget locating the right files and more budget
  // actually fixing things. Operator's own prompt is appended verbatim
  // below the separator so Jules sees it as the actual task.
  const codebaseMap = [
    "## Repository scope",
    "You have full read access to every file in this repository. Read whatever you need.",
    "",
    "## Codebase map",
    "- artifacts/api-server/src/routes/   — Express 5 route files. Every route gates on requirePermission(...).",
    "- artifacts/api-server/src/lib/      — Server-side helpers (auth, encryption, integrations, AI, automations, workers).",
    "- artifacts/api-server/src/lib/automations/ — Workflow engine (executor, recursive-retry, dispatch, schema-repair).",
    "- artifacts/api-server/src/lib/ai/   — AI resiliency v2 (circuit-breaker, error-classifier, observer, resilient-retry).",
    "- artifacts/api-server/src/scripts/  — Operator scripts (smoke, verify-*, seed-*, backfill-*).",
    "- artifacts/api-server/src/__tests__/ — node:test files. Run `pnpm --filter @workspace/api-server test`.",
    "- artifacts/mtos-crm/src/            — React 19 + Vite SPA. Pages under pages/, components under components/.",
    "- lib/db/src/schema/                 — Drizzle Postgres schema (49 tables).",
    "- lib/db/drizzle/                    — SQL migration files. `pnpm --filter @workspace/db run bootstrap` applies them.",
    "- docs/USER_MANUAL.md                — Operator manual (canonical source of behavior spec).",
    "- docs/AI_CONSTITUTION.md            — Bright lines AI MUST NEVER cross.",
    "- RAILWAY.md / .env.example          — Deployment + env contract.",
    "",
    "## House rules",
    "- Multi-tenant: every firm-scoped query MUST use `requireFirmId(req)` from lib/firm-scope.ts.",
    "- PII columns on leads (last_4_ssn, date_of_birth, address, diagnosis) are AES-256-GCM encrypted via lib/encryption.ts — pass (fieldName, entityId) for per-row AAD.",
    "- No raw SQL string concatenation. Use Drizzle's parameterized `sql` template.",
    "- No silent `.catch(() => {})`. Always log the error.",
    "- Smoke probes under artifacts/api-server/src/scripts/smoke.ts enforce these — run them before finalizing.",
    "",
    "## Operator request",
  ].join("\n");
  const promptWithScope = `${codebaseMap}\n${parsed.data.prompt}`;

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
      prompt: promptWithScope,
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

// Stop an in-flight session. Best-effort cancel against Jules; the local
// row is always marked `cancelled` regardless of upstream success because
// the local status is what the operator sees and we cannot leave a UI in
// "Working…" forever if Jules is unreachable. Idempotent — calling on an
// already-terminal session returns 200 with no Jules round-trip.
router.post("/:id/cancel", requirePermission(Permission.SELF_HEAL_MANAGE), async (req, res) => {
  const parsed = IdParam.safeParse(req.params);
  if (!parsed.success) return badRequest(res, "Invalid id");
  const row = await loadOwnedRow(req, parsed.data.id);
  if (!row) return notFound(res, "Session not found");

  // Terminal-status short circuit.
  if (["completed", "failed", "cancelled"].includes(row.status)) {
    return res.json({ session: row, jules_cancelled: false, reason: "already_terminal" });
  }

  let julesCancelled = false;
  let julesError: string | null = null;
  if (row.jules_session_id) {
    try {
      await julesCancelSession(row.jules_session_id);
      julesCancelled = true;
    } catch (err) {
      julesError = (err as Error).message;
      logger.warn({ err, sessionId: row.id, julesId: row.jules_session_id }, "Jules cancel failed — proceeding with local mark");
    }
  }

  const [updated] = await db
    .update(selfHealSessionsTable)
    .set({
      status: "cancelled",
      last_error: julesError ? `Jules cancel failed: ${julesError}` : row.last_error,
      updated_at: new Date(),
    })
    .where(eq(selfHealSessionsTable.id, row.id))
    .returning();

  await auditLog("self_heal_session", String(row.id), "cancelled", {
    firm_id: req.user!.firm_id,
    cancelled_by_user_id: req.user!.id,
    jules_session_id: row.jules_session_id,
    jules_cancelled: julesCancelled,
    jules_error: julesError,
    prior_status: row.status,
  });
  res.json({ session: updated, jules_cancelled: julesCancelled, jules_error: julesError });
});

// Hard-delete the local session row. Does NOT touch Jules (Jules keeps its
// own history; the operator can re-query via the session id if needed).
// Refuses to delete an in-flight session — the operator must cancel first
// so they don't accidentally lose track of a session that's actively
// writing a PR. Audit row keeps a record even though the table row is gone.
router.delete("/:id", requirePermission(Permission.SELF_HEAL_MANAGE), async (req, res) => {
  const parsed = IdParam.safeParse(req.params);
  if (!parsed.success) return badRequest(res, "Invalid id");
  const row = await loadOwnedRow(req, parsed.data.id);
  if (!row) return notFound(res, "Session not found");

  const inFlight = ["pending", "awaiting_approval", "dispatched", "working"].includes(row.status);
  if (inFlight) {
    return res.status(409).json({
      status: "error",
      code: "session_in_flight",
      message: `Cancel the session before deleting (current status: ${row.status}).`,
    });
  }

  await db
    .delete(selfHealSessionsTable)
    .where(and(eq(selfHealSessionsTable.id, row.id), eq(selfHealSessionsTable.firm_id, req.user!.firm_id)));

  await auditLog("self_heal_session", String(row.id), "deleted", {
    firm_id: req.user!.firm_id,
    deleted_by_user_id: req.user!.id,
    jules_session_id: row.jules_session_id,
    prior_status: row.status,
    title: row.title,
  });
  res.status(204).end();
});

export default router;
