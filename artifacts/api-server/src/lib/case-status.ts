/**
 * Single choke point for `cases.status` mutations (Task #52).
 *
 * Every code path that wants to advance / change a case's stage MUST go
 * through `updateCaseStatus` so we can guarantee:
 *   1. an audit_log row is written
 *   2. the `case.stage_changed` event is dispatched to subscribed
 *      automation integrations (n8n / Zapier / Make), but ONLY on a
 *      real transition (old !== new) — never as a no-op.
 *
 * This is the contract the n8n "case auto-advance" workflow listens
 * against. Bypassing it (i.e. raw `db.update(casesTable).set({status})`)
 * is a code smell — the matching n8n workflow will never fire.
 */
import { eq } from "drizzle-orm";
import { db, casesTable } from "@workspace/db";
import { auditLog } from "./audit";
import { dispatchEvent } from "./event-dispatcher";
import { logger } from "./logger";

export interface UpdateCaseStatusOptions {
  case_id: string;
  new_status: string;
  /** Who initiated this transition. "worker" for background jobs, user.id for HTTP routes. */
  changed_by: "worker" | number;
  /** Free-form context bag included in the event envelope + audit row. */
  context?: Record<string, unknown>;
  /** Source string passed through to the dispatcher for logging/tracing. */
  source?: string;
}

export interface UpdateCaseStatusResult {
  ok: boolean;
  /** True iff the row's status actually changed (old !== new). Event only fires when true. */
  transitioned: boolean;
  old_status: string | null;
  new_status: string;
}

export async function updateCaseStatus(
  opts: UpdateCaseStatusOptions,
): Promise<UpdateCaseStatusResult> {
  const { case_id, new_status, changed_by, context, source } = opts;

  // Capture prior status before the write so the event payload reports
  // the actual transition, not new === new.
  const [prior] = await db
    .select({ status: casesTable.status })
    .from(casesTable)
    .where(eq(casesTable.id, case_id));

  if (!prior) {
    return { ok: false, transitioned: false, old_status: null, new_status };
  }
  const old_status = prior.status ?? null;

  await db
    .update(casesTable)
    .set({ status: new_status, updated_at: new Date() })
    .where(eq(casesTable.id, case_id));

  const transitioned = old_status !== new_status;
  if (!transitioned) {
    return { ok: true, transitioned: false, old_status, new_status };
  }

  // Audit row: keep parity with other entity actions so the audit log
  // tells a complete story of how a case moved through stages.
  await auditLog("case", case_id, "status_changed", {
    old_status,
    new_status,
    changed_by,
    ...(context ?? {}),
  }).catch((err) => {
    logger.warn({ err, case_id }, "case status_changed audit insert failed");
  });

  dispatchEvent(
    {
      event: "case.stage_changed",
      payload: {
        case_id,
        old_status,
        new_status,
        changed_by: typeof changed_by === "number" ? "user" : "worker",
        ...(context ?? {}),
      },
    },
    { source: source ?? `case-status:${typeof changed_by === "number" ? "http" : "worker"}` },
  );

  return { ok: true, transitioned: true, old_status, new_status };
}
