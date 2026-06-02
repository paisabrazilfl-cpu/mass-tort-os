/**
 * Intake-to-Med-Recs deterministic pipeline state machine.
 *
 * This is the single source of truth for how a lead moves through the
 * mass-tort processing pipeline. Every stage advance goes through
 * `transitionLead()`, which:
 *
 *   1. Serializes concurrent advances of the same lead (SELECT ... FOR UPDATE).
 *   2. Suppresses duplicate provider events idempotently (by `event_key`).
 *   3. Rejects illegal transitions — the lead's status is NOT changed, but the
 *      attempt is recorded in `pipeline_events` with outcome 'illegal' so an
 *      operator can see something tried to skip/replay a stage.
 *   4. Applies a legal transition: updates `leads.pipeline_status` and appends
 *      an `pipeline_events` row, in one transaction.
 *
 * The state machine is intentionally deterministic: no AI, no probabilistic
 * routing. AI helpers (NPI match scoring, etc.) feed BOOLEAN facts into the
 * call sites that decide which legal transition to request — the machine
 * itself only enforces the legal graph.
 */
import { db, leadsTable, pipelineEventsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { logger } from "../logger";
import { auditLog } from "../audit";

export const PipelineStatus = {
  NEW: "NEW",
  BG_CHECK_PENDING: "BG_CHECK_PENDING",
  BG_CHECK_CLEAR: "BG_CHECK_CLEAR",
  BG_CHECK_FAILED: "BG_CHECK_FAILED",
  INTAKE_SENT: "INTAKE_SENT",
  INTAKE_COMPLETED: "INTAKE_COMPLETED",
  NPI_PENDING: "NPI_PENDING",
  NPI_VERIFIED: "NPI_VERIFIED",
  NPI_HOLD: "NPI_HOLD",
  DOCS_SENT: "DOCS_SENT",
  DOCS_SIGNED: "DOCS_SIGNED",
  HIPAA_FAXED: "HIPAA_FAXED",
  RETAINER_DISTRIBUTED: "RETAINER_DISTRIBUTED",
  AWAITING_MED_RECS: "AWAITING_MED_RECS",
  MED_RECS_RECEIVED: "MED_RECS_RECEIVED",
  COMPLETE: "COMPLETE",
  REJECTED: "REJECTED",
} as const;

export type PipelineStatusValue = (typeof PipelineStatus)[keyof typeof PipelineStatus];

/** Sentinel for "lead has no pipeline_status yet" (null in the DB). */
export const START = "__START__";

export const TERMINAL_STATES: ReadonlySet<string> = new Set([
  PipelineStatus.COMPLETE,
  PipelineStatus.REJECTED,
]);

/**
 * The legal directed graph. A transition from `X` to `Y` is allowed iff
 * `LEGAL_TRANSITIONS[X]` includes `Y`. Anything else is rejected.
 *
 * The DOCS_SIGNED → {HIPAA_FAXED, RETAINER_DISTRIBUTED} fan-out is modeled as
 * an order-independent diamond: both actions happen after all documents are
 * signed, in either order, and either one can advance to AWAITING_MED_RECS once
 * the HIPAA fax has been dispatched. The orchestrator drives both; the machine
 * only guarantees neither can be skipped illegally.
 */
export const LEGAL_TRANSITIONS: Readonly<Record<string, readonly PipelineStatusValue[]>> = {
  [START]: [PipelineStatus.NEW],
  [PipelineStatus.NEW]: [PipelineStatus.BG_CHECK_PENDING],
  [PipelineStatus.BG_CHECK_PENDING]: [PipelineStatus.BG_CHECK_CLEAR, PipelineStatus.BG_CHECK_FAILED],
  [PipelineStatus.BG_CHECK_CLEAR]: [PipelineStatus.INTAKE_SENT],
  [PipelineStatus.BG_CHECK_FAILED]: [PipelineStatus.REJECTED],
  [PipelineStatus.INTAKE_SENT]: [PipelineStatus.INTAKE_COMPLETED],
  [PipelineStatus.INTAKE_COMPLETED]: [PipelineStatus.NPI_PENDING],
  [PipelineStatus.NPI_PENDING]: [PipelineStatus.NPI_VERIFIED, PipelineStatus.NPI_HOLD],
  // Staff resolves a hold (manual NPI confirmation) → verified, or rejects it.
  [PipelineStatus.NPI_HOLD]: [PipelineStatus.NPI_VERIFIED, PipelineStatus.REJECTED],
  [PipelineStatus.NPI_VERIFIED]: [PipelineStatus.DOCS_SENT],
  [PipelineStatus.DOCS_SENT]: [PipelineStatus.DOCS_SIGNED],
  // Fan-out diamond (order independent):
  [PipelineStatus.DOCS_SIGNED]: [PipelineStatus.HIPAA_FAXED, PipelineStatus.RETAINER_DISTRIBUTED],
  [PipelineStatus.HIPAA_FAXED]: [PipelineStatus.RETAINER_DISTRIBUTED, PipelineStatus.AWAITING_MED_RECS],
  [PipelineStatus.RETAINER_DISTRIBUTED]: [PipelineStatus.HIPAA_FAXED, PipelineStatus.AWAITING_MED_RECS],
  [PipelineStatus.AWAITING_MED_RECS]: [PipelineStatus.MED_RECS_RECEIVED],
  [PipelineStatus.MED_RECS_RECEIVED]: [PipelineStatus.COMPLETE],
  [PipelineStatus.COMPLETE]: [],
  [PipelineStatus.REJECTED]: [],
};

export function isLegalTransition(from: string | null | undefined, to: string): boolean {
  const key = from ?? START;
  const allowed = LEGAL_TRANSITIONS[key];
  if (!allowed) return false;
  return (allowed as readonly string[]).includes(to);
}

export type TransitionOutcome =
  | "applied"
  | "illegal"
  | "duplicate"
  | "lead_not_found"
  | "firm_unresolved";

export interface TransitionRequest {
  leadId: number;
  to: PipelineStatusValue;
  trigger: string;
  /** Provider/event idempotency key. A second call with the same key is a no-op. */
  eventKey?: string | null;
  note?: string | null;
  payload?: Record<string, unknown> | null;
  source?: string;
  createdByUserId?: number | null;
}

export interface TransitionResult {
  outcome: TransitionOutcome;
  applied: boolean;
  from: string | null;
  to: PipelineStatusValue;
  /** The lead's pipeline_status AFTER this call (unchanged unless applied). */
  currentStatus: string | null;
  eventId?: number;
  reason?: string;
}

function isUniqueViolation(err: unknown): boolean {
  return Boolean(err && typeof err === "object" && (err as { code?: string }).code === "23505");
}

/**
 * Attempt a single pipeline transition. Deterministic, idempotent, and
 * transactional. See module header for the full contract.
 */
export async function transitionLead(req: TransitionRequest): Promise<TransitionResult> {
  const {
    leadId,
    to,
    trigger,
    eventKey = null,
    note = null,
    payload = null,
    source = "system",
    createdByUserId = null,
  } = req;

  return db.transaction(async (tx) => {
    // 1. Lock the lead row so concurrent transitions serialize.
    const [lead] = await tx
      .select({ id: leadsTable.id, firm_id: leadsTable.firm_id, pipeline_status: leadsTable.pipeline_status })
      .from(leadsTable)
      .where(eq(leadsTable.id, leadId))
      .for("update");

    if (!lead) {
      logger.warn({ leadId, to, trigger }, "pipeline: transition for unknown lead");
      return {
        outcome: "lead_not_found" as const,
        applied: false,
        from: null,
        to,
        currentStatus: null,
        reason: "lead_not_found",
      };
    }

    const from = lead.pipeline_status ?? null;
    const firmId = lead.firm_id ?? null;

    // 1b. Tenancy gate (Task #168): pipeline_events.firm_id is NON-NULL and
    // every transition is firm-scoped. A lead with no firm_id cannot be
    // advanced — writing a tenancy-less audit row would break firm isolation.
    // Refuse honestly (no event row, no status change) so the lead parks and
    // an operator can attach it to a firm. This is checked BEFORE idempotency
    // and the illegal/legal inserts so a null firm_id never reaches the table.
    if (firmId == null) {
      logger.warn({ leadId, to, trigger }, "pipeline: transition refused — lead has no firm_id");
      await auditLog("lead", String(leadId), "pipeline_firm_unresolved", { to, trigger });
      return {
        outcome: "firm_unresolved" as const,
        applied: false,
        from,
        to,
        currentStatus: from,
        reason: "firm_unresolved",
      };
    }

    // 2. Idempotency: a prior event with this key already settled this step.
    if (eventKey) {
      const [dup] = await tx
        .select({ id: pipelineEventsTable.id })
        .from(pipelineEventsTable)
        .where(eq(pipelineEventsTable.event_key, eventKey))
        .limit(1);
      if (dup) {
        logger.info({ leadId, eventKey, trigger }, "pipeline: duplicate event suppressed");
        return {
          outcome: "duplicate" as const,
          applied: false,
          from,
          to,
          currentStatus: from,
          eventId: dup.id,
          reason: "duplicate_event",
        };
      }
    }

    // 3. Illegal transition — record the attempt, do NOT mutate the lead.
    if (!isLegalTransition(from, to)) {
      const [evt] = await tx
        .insert(pipelineEventsTable)
        .values({
          firm_id: firmId,
          lead_id: leadId,
          from_status: from,
          to_status: to,
          trigger,
          applied: false,
          outcome: "illegal",
          // Do NOT claim the event_key on a rejected attempt — a later legal
          // retry with the same key must still be able to proceed. Preserve it
          // in the payload for forensics instead.
          event_key: null,
          note: note ?? `Illegal transition ${from ?? START} -> ${to}`,
          payload: { ...(payload ?? {}), attempted_event_key: eventKey ?? null },
          source,
          created_by_user_id: createdByUserId,
        })
        .returning({ id: pipelineEventsTable.id });
      logger.warn({ leadId, from, to, trigger }, "pipeline: illegal transition rejected");
      await auditLog("lead", String(leadId), "pipeline_illegal_transition", {
        from,
        to,
        trigger,
        event_id: evt?.id ?? null,
      });
      return {
        outcome: "illegal" as const,
        applied: false,
        from,
        to,
        currentStatus: from,
        eventId: evt?.id,
        reason: "illegal_transition",
      };
    }

    // 4. Legal — advance the lead and append the event atomically.
    await tx
      .update(leadsTable)
      .set({ pipeline_status: to, updated_at: new Date() })
      .where(eq(leadsTable.id, leadId));

    let eventId: number | undefined;
    try {
      const [evt] = await tx
        .insert(pipelineEventsTable)
        .values({
          firm_id: firmId,
          lead_id: leadId,
          from_status: from,
          to_status: to,
          trigger,
          applied: true,
          outcome: "applied",
          event_key: eventKey,
          note,
          payload: payload ?? null,
          source,
          created_by_user_id: createdByUserId,
        })
        .returning({ id: pipelineEventsTable.id });
      eventId = evt?.id;
    } catch (err) {
      // Lost an idempotency race: another tx inserted the same event_key first.
      // Roll back our lead update by throwing so the transaction aborts, then
      // report duplicate to the caller (the winning tx already applied it).
      if (isUniqueViolation(err)) {
        logger.info({ leadId, eventKey }, "pipeline: idempotency race lost — treating as duplicate");
        throw new PipelineDuplicateError(from, to);
      }
      throw err;
    }

    await auditLog("lead", String(leadId), "pipeline_transition", {
      from,
      to,
      trigger,
      event_id: eventId ?? null,
    });

    return {
      outcome: "applied" as const,
      applied: true,
      from,
      to,
      currentStatus: to,
      eventId,
    };
  }).catch((err: unknown) => {
    if (err instanceof PipelineDuplicateError) {
      return {
        outcome: "duplicate" as const,
        applied: false,
        from: err.from,
        to: err.to,
        currentStatus: err.from,
        reason: "duplicate_event_race",
      };
    }
    throw err;
  });
}

class PipelineDuplicateError extends Error {
  constructor(public from: string | null, public to: PipelineStatusValue) {
    super("pipeline_duplicate");
    this.name = "PipelineDuplicateError";
  }
}
