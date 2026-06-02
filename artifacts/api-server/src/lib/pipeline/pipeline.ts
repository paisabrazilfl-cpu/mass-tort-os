/**
 * Pipeline orchestration.
 *
 * The state machine (`state-machine.ts`) enforces the legal graph; this module
 * is the layer that decides WHICH legal transition to request in response to a
 * real-world event, and fires the deterministic side effects that belong to
 * each stage (enqueue a bg-check job, send the intake/rejection email, run
 * NPPES, dispatch the HIPAA fax, …).
 *
 * Every public function here is idempotent: each transition carries an
 * `event_key` derived from the lead id + stage, so a replayed webhook or a
 * re-enqueued job advances the lead at most once.
 */
import {
  db,
  leadsTable,
  documentEnvelopesTable,
  documentsTable,
} from "@workspace/db";
import { eq, and } from "drizzle-orm";
import { logger } from "../logger";
import { auditLog } from "../audit";
import { enqueueJob } from "../queue.js";
import { decryptLeadFields } from "../encryption.js";
import { sendEmailViaRouter } from "../email/send.js";
import {
  transitionLead,
  PipelineStatus,
  type PipelineStatusValue,
  type TransitionResult,
} from "./state-machine.js";
import {
  getBackgroundCheckAdapter,
  getBackgroundCheckProvider,
  getNpiAdapter,
  type BgVerdict,
} from "./adapters.js";
import { allDocumentsSigned } from "./doc-types.js";
import type { VerifyProviderInput } from "../npi-verify.js";

// Re-exported so existing importers (webhooks, tests) keep the same surface.
// The real DOCS_SIGNED gate is `allRequiredDocumentsSigned` in ./doc-types.js,
// which tracks each of the three required document types independently.
export { allDocumentsSigned } from "./doc-types.js";

function eventKey(stage: string, leadId: number, suffix?: string): string {
  return suffix ? `${stage}:${leadId}:${suffix}` : `${stage}:${leadId}`;
}

async function getLeadContact(leadId: number): Promise<{ name: string; email: string | null } | null> {
  const [lead] = await db.select().from(leadsTable).where(eq(leadsTable.id, leadId));
  if (!lead) return null;
  const decrypted = decryptLeadFields(lead as Record<string, unknown>);
  const email = typeof decrypted.email === "string" && decrypted.email ? decrypted.email : null;
  const name =
    (typeof decrypted.name === "string" && decrypted.name) ||
    `${decrypted.first_name ?? ""} ${decrypted.last_name ?? ""}`.trim() ||
    "Claimant";
  return { name, email };
}

// ===========================================================================
// STAGE: entry → bg check
// ===========================================================================

/**
 * Bring a freshly-created lead into the pipeline: START → NEW →
 * BG_CHECK_PENDING, then enqueue the background check. Idempotent — safe to
 * call again on a re-submitted lead (the per-stage event keys ensure each step
 * applies at most once, and a lead already past NEW simply logs illegal no-ops).
 */
export async function startLeadPipeline(
  leadId: number,
  opts: { source?: string; createdByUserId?: number | null; firmId?: number | null } = {},
): Promise<void> {
  const source = opts.source ?? "intake";
  const created = await transitionLead({
    leadId,
    to: PipelineStatus.NEW,
    trigger: "lead_created",
    eventKey: eventKey("lead_created", leadId),
    source,
    createdByUserId: opts.createdByUserId ?? null,
  });
  // Only continue the bootstrap when we actually entered (or already were at)
  // a state from which BG_CHECK_PENDING is reachable.
  await transitionLead({
    leadId,
    to: PipelineStatus.BG_CHECK_PENDING,
    trigger: "bg_check_started",
    eventKey: eventKey("bg_check_started", leadId),
    source,
    createdByUserId: opts.createdByUserId ?? null,
  });

  // Enqueue the check only for the in-repo hub provider. For an external vendor
  // the lead parks at BG_CHECK_PENDING until the vendor posts to the webhook.
  if (getBackgroundCheckProvider() === "hub") {
    try {
      const jobId = await enqueueJob("run_bg_check", { lead_id: leadId, source });
      await auditLog("lead", String(leadId), "pipeline_bg_check_enqueued", { job_id: jobId, source });
    } catch (err) {
      logger.error({ err, leadId }, "pipeline: failed to enqueue bg check job");
      throw err;
    }
  } else {
    await auditLog("lead", String(leadId), "pipeline_bg_check_external_pending", {
      provider: "external",
    });
    logger.info({ leadId }, "pipeline: external bg-check provider — awaiting vendor webhook");
  }
  logger.info({ leadId, entered: created.outcome }, "pipeline: lead entered");
}

// ===========================================================================
// STAGE: bg-check verdict → clear/failed
// ===========================================================================

/**
 * Apply a background-check verdict to a lead sitting at BG_CHECK_PENDING.
 *   CLEAR  → BG_CHECK_CLEAR → INTAKE_SENT (+ intake email)
 *   FAILED → BG_CHECK_FAILED → REJECTED  (+ rejection email)
 *   REVIEW → no transition; parked for an operator.
 *
 * `keySuffix` should be a stable per-result token (the vendor event id, or the
 * job id for the hub path) so replays are idempotent.
 */
export async function applyBackgroundCheckVerdict(
  leadId: number,
  verdict: BgVerdict,
  opts: { keySuffix: string; source?: string; payload?: Record<string, unknown> | null } = { keySuffix: "" },
): Promise<{ verdict: BgVerdict; transitions: TransitionResult[] }> {
  const source = opts.source ?? "bg_check";
  const transitions: TransitionResult[] = [];

  if (verdict === "CLEAR") {
    transitions.push(
      await transitionLead({
        leadId,
        to: PipelineStatus.BG_CHECK_CLEAR,
        trigger: "bg_check_clear",
        eventKey: eventKey("bg_check_clear", leadId, opts.keySuffix),
        source,
        payload: opts.payload ?? null,
      }),
    );
    const sent = await transitionLead({
      leadId,
      to: PipelineStatus.INTAKE_SENT,
      trigger: "intake_dispatched",
      eventKey: eventKey("intake_sent", leadId, opts.keySuffix),
      source,
    });
    transitions.push(sent);
    if (sent.applied) await sendIntakeEmail(leadId);
  } else if (verdict === "FAILED") {
    transitions.push(
      await transitionLead({
        leadId,
        to: PipelineStatus.BG_CHECK_FAILED,
        trigger: "bg_check_failed",
        eventKey: eventKey("bg_check_failed", leadId, opts.keySuffix),
        source,
        payload: opts.payload ?? null,
      }),
    );
    const rejected = await transitionLead({
      leadId,
      to: PipelineStatus.REJECTED,
      trigger: "bg_check_rejected",
      eventKey: eventKey("rejected", leadId, opts.keySuffix),
      source,
    });
    transitions.push(rejected);
    if (rejected.applied) await sendRejectionEmail(leadId);
  } else {
    // REVIEW_REQUIRED / NOT_RUN — do not advance, leave for an operator.
    await auditLog("lead", String(leadId), "pipeline_bg_check_review", {
      verdict,
      key_suffix: opts.keySuffix,
    });
    logger.info({ leadId, verdict }, "pipeline: bg-check needs operator review — not advanced");
  }
  return { verdict, transitions };
}

/** Run the in-repo background-check hub for a lead, then apply the verdict. */
export async function runBackgroundCheckForLead(
  leadId: number,
  opts: { keySuffix: string; source?: string },
): Promise<{ ran: boolean; verdict?: BgVerdict }> {
  const adapter = getBackgroundCheckAdapter();
  if (!adapter) {
    logger.info({ leadId }, "pipeline: bg-check provider is external — worker will not run hub");
    return { ran: false };
  }
  const [lead] = await db.select().from(leadsTable).where(eq(leadsTable.id, leadId));
  if (!lead) throw new Error(`Lead ${leadId} not found for bg check`);
  const decrypted = decryptLeadFields(lead as Record<string, unknown>);
  const outcome = await adapter.run({
    id: leadId,
    first_name: (decrypted.first_name as string) ?? null,
    last_name: (decrypted.last_name as string) ?? null,
    full_name: (decrypted.name as string) ?? null,
    email: (decrypted.email as string) ?? null,
    phone: (decrypted.phone as string) ?? (decrypted.phone_primary as string) ?? null,
    address: (decrypted.address as string) ?? null,
    city: (decrypted.city as string) ?? null,
    state: (decrypted.state as string) ?? null,
    zip: (decrypted.zip as string) ?? null,
    dob: (decrypted.dob as string) ?? null,
    business_name: (decrypted.business_name as string) ?? null,
  });
  await applyBackgroundCheckVerdict(leadId, outcome.verdict, {
    keySuffix: opts.keySuffix,
    source: opts.source ?? "bg_hub",
    payload: { final_status: outcome.finalStatus, score: outcome.score, version: outcome.raw.version },
  });
  return { ran: true, verdict: outcome.verdict };
}

// ===========================================================================
// STAGE: intake completed → NPI verification
// ===========================================================================

/**
 * The claimant finished the intake form: INTAKE_SENT → INTAKE_COMPLETED, then
 * kick off provider verification.
 */
export async function completeIntake(
  leadId: number,
  npiInput: VerifyProviderInput,
  opts: { keySuffix?: string; source?: string } = {},
): Promise<{ transitions: TransitionResult[]; npiVerdict?: "VERIFIED" | "HOLD" }> {
  const source = opts.source ?? "intake_form";
  const transitions: TransitionResult[] = [];
  const completed = await transitionLead({
    leadId,
    to: PipelineStatus.INTAKE_COMPLETED,
    trigger: "intake_completed",
    eventKey: eventKey("intake_completed", leadId, opts.keySuffix),
    source,
  });
  transitions.push(completed);
  const npi = await runNpiForLead(leadId, npiInput, { keySuffix: opts.keySuffix, source });
  transitions.push(...npi.transitions);
  return { transitions, npiVerdict: npi.verdict };
}

/**
 * INTAKE_COMPLETED → NPI_PENDING, run live NPPES, then NPI_VERIFIED | NPI_HOLD.
 * On VERIFIED, persists the provider fax onto the lead for the later HIPAA fax.
 */
export async function runNpiForLead(
  leadId: number,
  npiInput: VerifyProviderInput,
  opts: { keySuffix?: string; source?: string } = {},
): Promise<{ verdict: "VERIFIED" | "HOLD"; transitions: TransitionResult[] }> {
  const source = opts.source ?? "npi";
  const transitions: TransitionResult[] = [];
  const pending = await transitionLead({
    leadId,
    to: PipelineStatus.NPI_PENDING,
    trigger: "npi_started",
    eventKey: eventKey("npi_pending", leadId, opts.keySuffix),
    source,
  });
  transitions.push(pending);

  const outcome = await getNpiAdapter().verify(npiInput);
  const to: PipelineStatusValue =
    outcome.verdict === "VERIFIED" ? PipelineStatus.NPI_VERIFIED : PipelineStatus.NPI_HOLD;

  // Stash the verified provider fax so the HIPAA MRR fax has a target.
  if (outcome.verdict === "VERIFIED" && outcome.providerFax) {
    try {
      await db
        .update(leadsTable)
        .set({ hospital_fax: outcome.providerFax, updated_at: new Date() })
        .where(eq(leadsTable.id, leadId));
    } catch (err) {
      logger.warn({ err, leadId }, "pipeline: failed to persist provider fax");
    }
  }

  const verifiedTransition = await transitionLead({
    leadId,
    to,
    trigger: outcome.verdict === "VERIFIED" ? "npi_verified" : "npi_hold",
    eventKey: eventKey(outcome.verdict === "VERIFIED" ? "npi_verified" : "npi_hold", leadId, opts.keySuffix),
    source,
    payload: { status: outcome.status, provider_npi: outcome.providerNpi },
  });
  transitions.push(verifiedTransition);

  // Spec step 6: once NPI is verified, send the three required e-sign documents
  // (HIPAA + Retainer + Affidavit). Gated on the NPI_VERIFIED transition having
  // ACTUALLY applied — a duplicate replay, an illegal edge, or a firm_unresolved
  // park must not trigger a fresh document send. Non-blocking: a dispatch problem
  // must not fail the NPI verdict; the lead parks at NPI_VERIFIED for re-dispatch.
  if (outcome.verdict === "VERIFIED" && verifiedTransition.applied) {
    try {
      await sendPipelineDocuments(leadId);
    } catch (err) {
      logger.warn({ err, leadId }, "pipeline: sendPipelineDocuments failed (non-blocking)");
    }
  }
  return { verdict: outcome.verdict, transitions };
}

// ===========================================================================
// STAGE: documents signed → fan-out → awaiting med recs
// ===========================================================================

/**
 * Spec step 6 send: dispatch the three required e-sign documents for a lead
 * whose NPI is verified. The actual envelope creation + provider dispatch is
 * owned by the existing approval-packet path (`enqueueLeadApprovalPackets` →
 * `send_esign_packet` worker), which now tags each envelope with its `doc_type`
 * so the DOCS_SIGNED gate can track HIPAA/Retainer/Affidavit independently.
 *
 * This is deliberately a thin wrapper: it records the DOCS_SENT pipeline stage
 * (idempotent) and then delegates to the live dispatcher. If no matching active
 * templates exist, the dispatcher logs an honest "no_active_templates" skip and
 * the lead waits — we never pretend documents were sent.
 */
export async function sendPipelineDocuments(
  leadId: number,
  opts: { keySuffix?: string; source?: string } = {},
): Promise<{ transition: TransitionResult | null; dispatched: boolean }> {
  const source = opts.source ?? "pipeline";
  // Dispatch FIRST, then record DOCS_SENT only if documents were actually sent.
  // enqueueLeadApprovalPackets never throws; it returns a structured summary.
  // Lazy import to avoid a module cycle (workflow-engine → pipeline).
  const { enqueueLeadApprovalPackets } = await import("../workflow-engine.js");
  const dispatch = await enqueueLeadApprovalPackets(leadId);
  // "Documents were sent" is true when we enqueued at least one packet, OR an
  // idempotent replay found they were already dispatched (genuinely sent before).
  // If nothing was enqueued and nothing pre-existed (no active templates, no
  // signer email, all disabled), we did NOT send anything — do not fake DOCS_SENT;
  // the lead parks at NPI_VERIFIED so an operator/automation can fix and retry.
  const alreadySent = dispatch.skipped.some((s) => s.reason === "already_dispatched");
  const dispatched = dispatch.enqueued.length > 0 || alreadySent;
  if (!dispatched) {
    logger.info(
      { leadId, skipped: dispatch.skipped.map((s) => s.reason) },
      "pipeline: no documents dispatched — holding DOCS_SENT (honest blocker)",
    );
    return { transition: null, dispatched: false };
  }
  const transition = await transitionLead({
    leadId,
    to: PipelineStatus.DOCS_SENT,
    trigger: "docs_sent",
    eventKey: eventKey("docs_sent", leadId, opts.keySuffix),
    source,
  });
  return { transition, dispatched: true };
}

/**
 * Distribute a SIGNED retainer to its two required destinations:
 *   A) the attorney of record (lead.assigned_to) — recorded as a handoff, and
 *   B) the CRM document store (a `documents` row, document_type=retainer_agreement).
 *
 * Returns { distributed:false, reason } when the prerequisites are not met (no
 * signed retainer envelope/PDF, or no attorney assigned) so the caller can park
 * the lead instead of recording a fake RETAINER_DISTRIBUTED. Idempotent: a
 * second call when the documents row already exists is a no-op success.
 */
async function distributeRetainer(
  leadId: number,
  opts: { source: string },
): Promise<{ distributed: boolean; reason?: string; destinations: string[] }> {
  // 1. Find a SIGNED retainer envelope with an actual signed artifact.
  const retainers = await db
    .select()
    .from(documentEnvelopesTable)
    .where(
      and(
        eq(documentEnvelopesTable.lead_id, leadId),
        eq(documentEnvelopesTable.doc_type, "retainer"),
        eq(documentEnvelopesTable.status, "signed"),
      ),
    );
  const signed = retainers.find((e) => Boolean(e.signed_pdf_path));
  if (!signed) {
    return { distributed: false, reason: "no_signed_retainer_pdf", destinations: [] };
  }

  // 2. Destination A — attorney of record. Without one, we cannot hand off.
  const [lead] = await db
    .select({ id: leadsTable.id, assigned_to: leadsTable.assigned_to })
    .from(leadsTable)
    .where(eq(leadsTable.id, leadId));
  const attorneyId = lead?.assigned_to ?? null;
  if (attorneyId == null) {
    return { distributed: false, reason: "no_attorney_of_record", destinations: [] };
  }

  const destinations: string[] = [];
  try {
    // Destination A: record the signed-retainer handoff to the attorney.
    await auditLog("lead", String(leadId), "retainer_distributed_to_attorney", {
      attorney_user_id: attorneyId,
      envelope_id: signed.id,
      signed_pdf_path: signed.signed_pdf_path,
    });
    destinations.push(`attorney:${attorneyId}`);

    // Destination B: CRM document store. Idempotent — skip if already stored.
    const existing = await db
      .select({ id: documentsTable.id })
      .from(documentsTable)
      .where(
        and(
          eq(documentsTable.lead_id, leadId),
          eq(documentsTable.document_type, "retainer_agreement"),
        ),
      );
    if (existing.length === 0) {
      await db.insert(documentsTable).values({
        lead_id: leadId,
        document_type: "retainer_agreement",
        file_name: `retainer-lead-${leadId}.pdf`,
        file_url: signed.signed_pdf_path,
        signed: true,
        signed_at: signed.signed_at ?? new Date(),
        notes: `Distributed from signed e-sign envelope #${signed.id}`,
      });
    }
    destinations.push("crm_document_store");
  } catch (err) {
    // A real failure mid-distribution: do NOT claim success. The lead parks and
    // a retry (idempotent) can complete distribution.
    logger.error({ err, leadId }, "pipeline: retainer distribution failed");
    return { distributed: false, reason: "distribution_error", destinations };
  }

  void opts; // source reserved for future per-destination provenance
  return { distributed: true, destinations };
}

/**
 * All retainer/HIPAA documents for the lead are signed. Advances
 * NPI_VERIFIED → DOCS_SENT → DOCS_SIGNED (each idempotent), then performs the
 * order-independent fan-out: HIPAA_FAXED + RETAINER_DISTRIBUTED →
 * AWAITING_MED_RECS. The actual HIPAA fax dispatch is owned by the existing
 * `onEnvelopeSigned`/`fax_med_records_request` path; here we record the
 * pipeline state so the stage is auditable and cannot be skipped.
 */
export async function applyDocumentsSigned(
  leadId: number,
  opts: { keySuffix: string; envelopeId?: number; source?: string; hipaaFaxed?: boolean },
): Promise<{ transitions: TransitionResult[] }> {
  const source = opts.source ?? "esign";
  const transitions: TransitionResult[] = [];

  // Walk forward through any not-yet-applied prerequisite states. Each is
  // idempotent; a lead already further along just records illegal no-ops we
  // ignore. We only chase the legal next hops we expect to see here.
  transitions.push(
    await transitionLead({
      leadId,
      to: PipelineStatus.DOCS_SENT,
      trigger: "docs_sent",
      eventKey: eventKey("docs_sent", leadId, opts.keySuffix),
      source,
    }),
  );
  transitions.push(
    await transitionLead({
      leadId,
      to: PipelineStatus.DOCS_SIGNED,
      trigger: "docs_signed",
      eventKey: eventKey("docs_signed", leadId, opts.keySuffix),
      source,
      payload: opts.envelopeId ? { envelope_id: opts.envelopeId } : null,
    }),
  );

  // Fan-out diamond. The HIPAA fax dispatch happens via onEnvelopeSigned; mark
  // HIPAA_FAXED only when that path reports it was dispatched (hipaaFaxed).
  if (opts.hipaaFaxed) {
    transitions.push(
      await transitionLead({
        leadId,
        to: PipelineStatus.HIPAA_FAXED,
        trigger: "hipaa_faxed",
        eventKey: eventKey("hipaa_faxed", leadId, opts.keySuffix),
        source,
      }),
    );
  }
  // RETAINER_DISTRIBUTED is a REAL side effect, not a bookkeeping hop: the
  // signed retainer must reach BOTH destinations — the attorney of record and
  // the CRM document store — before we record it. If distribution can't happen
  // (no signed retainer PDF yet, or no attorney assigned), we DO NOT fake the
  // transition; the lead simply parks at the fan-out and an operator/automation
  // can retry. This keeps the audit trail honest.
  const dist = await distributeRetainer(leadId, { source });
  if (dist.distributed) {
    transitions.push(
      await transitionLead({
        leadId,
        to: PipelineStatus.RETAINER_DISTRIBUTED,
        trigger: "retainer_distributed",
        eventKey: eventKey("retainer_distributed", leadId, opts.keySuffix),
        source,
        payload: { destinations: dist.destinations },
      }),
    );
  } else {
    logger.info(
      { leadId, reason: dist.reason },
      "pipeline: retainer not distributed — holding RETAINER_DISTRIBUTED (honest blocker)",
    );
  }
  // Advance to AWAITING_MED_RECS only once the HIPAA fax has gone out (that is
  // the gate for medical records). If it has not, the lead waits at the
  // fan-out until the fax dispatches.
  if (opts.hipaaFaxed) {
    transitions.push(
      await transitionLead({
        leadId,
        to: PipelineStatus.AWAITING_MED_RECS,
        trigger: "awaiting_med_recs",
        eventKey: eventKey("awaiting_med_recs", leadId, opts.keySuffix),
        source,
      }),
    );
  }
  return { transitions };
}

/** Mark the HIPAA fax dispatched and advance to AWAITING_MED_RECS. */
export async function markHipaaFaxed(
  leadId: number,
  opts: { keySuffix: string; source?: string },
): Promise<{ transitions: TransitionResult[] }> {
  const source = opts.source ?? "fax";
  const transitions: TransitionResult[] = [];
  transitions.push(
    await transitionLead({
      leadId,
      to: PipelineStatus.HIPAA_FAXED,
      trigger: "hipaa_faxed",
      eventKey: eventKey("hipaa_faxed", leadId, opts.keySuffix),
      source,
    }),
  );
  transitions.push(
    await transitionLead({
      leadId,
      to: PipelineStatus.AWAITING_MED_RECS,
      trigger: "awaiting_med_recs",
      eventKey: eventKey("awaiting_med_recs", leadId, opts.keySuffix),
      source,
    }),
  );
  return { transitions };
}

// ===========================================================================
// STAGE: inbound medical records → complete
// ===========================================================================

/**
 * Inbound medical records arrived for the lead: AWAITING_MED_RECS →
 * MED_RECS_RECEIVED → COMPLETE. Idempotent by `keySuffix` (the inbound fax id).
 */
export async function applyMedRecordsReceived(
  leadId: number,
  opts: { keySuffix: string; source?: string; payload?: Record<string, unknown> | null },
): Promise<{ transitions: TransitionResult[] }> {
  const source = opts.source ?? "inbound_fax";
  const transitions: TransitionResult[] = [];
  transitions.push(
    await transitionLead({
      leadId,
      to: PipelineStatus.MED_RECS_RECEIVED,
      trigger: "med_recs_received",
      eventKey: eventKey("med_recs_received", leadId, opts.keySuffix),
      source,
      payload: opts.payload ?? null,
    }),
  );
  transitions.push(
    await transitionLead({
      leadId,
      to: PipelineStatus.COMPLETE,
      trigger: "pipeline_complete",
      eventKey: eventKey("complete", leadId, opts.keySuffix),
      source,
    }),
  );
  return { transitions };
}

// ===========================================================================
// Emails (best-effort; never throw into the pipeline)
// ===========================================================================

async function sendIntakeEmail(leadId: number): Promise<void> {
  try {
    const contact = await getLeadContact(leadId);
    if (!contact?.email) {
      logger.info({ leadId }, "pipeline: no email on lead — skipping intake email");
      return;
    }
    await sendEmailViaRouter({
      to: contact.email,
      toName: contact.name,
      subject: "Next step: complete your intake",
      html: `<p>Hello ${contact.name},</p><p>Your initial review is complete and you have cleared our preliminary checks. Please complete your intake so we can proceed with your claim.</p>`,
      leadId,
    });
  } catch (err) {
    logger.warn({ err, leadId }, "pipeline: intake email send failed (non-blocking)");
  }
}

async function sendRejectionEmail(leadId: number): Promise<void> {
  try {
    const contact = await getLeadContact(leadId);
    if (!contact?.email) return;
    await sendEmailViaRouter({
      to: contact.email,
      toName: contact.name,
      subject: "Update on your inquiry",
      html: `<p>Hello ${contact.name},</p><p>Thank you for your interest. After our initial review, we are unable to move forward with your inquiry at this time.</p>`,
      leadId,
    });
  } catch (err) {
    logger.warn({ err, leadId }, "pipeline: rejection email send failed (non-blocking)");
  }
}
