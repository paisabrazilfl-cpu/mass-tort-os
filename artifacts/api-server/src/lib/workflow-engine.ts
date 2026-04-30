/**
 * Workflow Engine — orchestrates the document automation flow.
 *
 *   lead.status="approved"  →  enqueueLeadApprovalPackets()  →  one send_esign_packet job per enabled template
 *   envelope signed         →  onEnvelopeSigned()           →  fax_med_records_request job (if HIPAA + tort wants it)
 *
 * All operations are best-effort: provider misses are logged + audited but never throw.
 * Idempotent on (lead_id, template_id) — re-approving a lead does not create duplicate envelopes.
 */
import { db, leadsTable, documentTemplatesTable, templateAssignmentsTable, documentEnvelopesTable, buyersTable } from "@workspace/db";
import { eq, and, isNull, or } from "drizzle-orm";
import { enqueueJob } from "./queue";
import { auditLog } from "./audit";
import { logger } from "./logger";
import { getSignerFromLead } from "./workflow-handlers";

export interface ApprovalDispatchResult {
  lead_id: number;
  enqueued: Array<{ template_id: number; template_name: string; job_id: number }>;
  skipped: Array<{ template_id: number; template_name: string; reason: string }>;
}

/**
 * Decide whether a given (template, buyer, tort) combination should fire.
 * Resolution: row-for-(buyer,tort) > row-for-(NULL,tort) > template.active default.
 */
async function shouldSendTemplate(
  templateId: number,
  templateActive: boolean,
  buyerId: number | null,
  tortType: string,
): Promise<boolean> {
  const assignments = await db
    .select()
    .from(templateAssignmentsTable)
    .where(
      and(
        eq(templateAssignmentsTable.template_id, templateId),
        eq(templateAssignmentsTable.tort_type, tortType),
        buyerId
          ? or(
              eq(templateAssignmentsTable.buyer_id, buyerId),
              isNull(templateAssignmentsTable.buyer_id),
            )
          : isNull(templateAssignmentsTable.buyer_id),
      ),
    );

  if (assignments.length === 0) {
    return templateActive;
  }

  const buyerSpecific = assignments.find((a) => a.buyer_id === buyerId);
  if (buyerSpecific) return buyerSpecific.enabled;

  const tortDefault = assignments.find((a) => a.buyer_id === null);
  if (tortDefault) return tortDefault.enabled;

  return templateActive;
}

/**
 * Idempotency check: did we already dispatch this template for this lead?
 */
async function envelopeAlreadyExists(leadId: number, templateId: number): Promise<boolean> {
  const [existing] = await db
    .select({ id: documentEnvelopesTable.id })
    .from(documentEnvelopesTable)
    .where(
      and(
        eq(documentEnvelopesTable.lead_id, leadId),
        eq(documentEnvelopesTable.template_id, templateId),
      ),
    );
  return Boolean(existing);
}

/**
 * Main entry: lead just transitioned to "approved" — enqueue an e-sign job
 * for every template that should be sent given the lead's tort + buyer.
 *
 * Never throws. Returns a structured summary that callers can log/inspect/audit.
 */
export async function enqueueLeadApprovalPackets(leadId: number): Promise<ApprovalDispatchResult> {
  const result: ApprovalDispatchResult = { lead_id: leadId, enqueued: [], skipped: [] };

  let lead;
  try {
    [lead] = await db.select().from(leadsTable).where(eq(leadsTable.id, leadId));
  } catch (err) {
    logger.error({ err, lead_id: leadId }, "enqueueLeadApprovalPackets: failed to load lead");
    return result;
  }

  if (!lead) {
    logger.warn({ lead_id: leadId }, "enqueueLeadApprovalPackets: lead not found");
    return result;
  }

  const tortType = lead.tort_type;
  const buyerId = lead.buyer_id ?? null;

  const templates = await db
    .select()
    .from(documentTemplatesTable)
    .where(eq(documentTemplatesTable.active, true));

  if (templates.length === 0) {
    logger.info({ lead_id: leadId }, "No active document templates — nothing to dispatch");
    await auditLog("lead", String(leadId), "approval_dispatch_skipped", {
      reason: "no_active_templates",
    });
    return result;
  }

  // Pre-flight: if the lead has no signer email at all, every send_esign_packet
  // job we enqueue is guaranteed to fail in the worker. Skip the whole batch
  // up-front with a clear audit reason so the bad jobs never enter the queue
  // and burn worker cycles on doomed retries.
  const signer = getSignerFromLead(lead);
  if (!signer) {
    logger.warn({ lead_id: leadId }, "enqueueLeadApprovalPackets: lead has no signer email — skipping batch");
    await auditLog("lead", String(leadId), "approval_dispatch_skipped", {
      reason: "no_signer_email",
      template_count: templates.length,
    });
    for (const tpl of templates) {
      result.skipped.push({
        template_id: tpl.id,
        template_name: tpl.name,
        reason: "no_signer_email",
      });
    }
    return result;
  }

  for (const tpl of templates) {
    try {
      const send = await shouldSendTemplate(tpl.id, tpl.active, buyerId, tortType);
      if (!send) {
        result.skipped.push({
          template_id: tpl.id,
          template_name: tpl.name,
          reason: "disabled_for_tort_or_buyer",
        });
        continue;
      }

      if (await envelopeAlreadyExists(leadId, tpl.id)) {
        result.skipped.push({
          template_id: tpl.id,
          template_name: tpl.name,
          reason: "already_dispatched",
        });
        continue;
      }

      const jobId = await enqueueJob("send_esign_packet", {
        lead_id: leadId,
        template_id: tpl.id,
      });
      result.enqueued.push({ template_id: tpl.id, template_name: tpl.name, job_id: jobId });
    } catch (err) {
      logger.error(
        { err, lead_id: leadId, template_id: tpl.id },
        "Failed to enqueue template — continuing with remaining templates",
      );
      result.skipped.push({
        template_id: tpl.id,
        template_name: tpl.name,
        reason: `enqueue_error: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  await auditLog("lead", String(leadId), "approval_dispatched", {
    enqueued_count: result.enqueued.length,
    skipped_count: result.skipped.length,
    enqueued: result.enqueued.map((e) => ({ template_id: e.template_id, name: e.template_name })),
    skipped: result.skipped.map((s) => ({ template_id: s.template_id, reason: s.reason })),
  });

  // Optional: pre-load buyer for any future per-buyer logic to surface to the user.
  if (buyerId) {
    try {
      await db.select({ id: buyersTable.id }).from(buyersTable).where(eq(buyersTable.id, buyerId));
    } catch {
      /* ignore */
    }
  }

  logger.info(
    { lead_id: leadId, enqueued: result.enqueued.length, skipped: result.skipped.length },
    "Lead approval dispatch complete",
  );
  return result;
}

/**
 * Webhook callback: an envelope was just marked signed.
 * If the underlying template is the HIPAA / med-records-trigger template AND
 * the lead has a doctor/hospital fax on file, enqueue a fax job.
 */
export async function onEnvelopeSigned(envelopeId: number): Promise<{ enqueued_fax_job_id: number | null; reason?: string }> {
  const [env] = await db
    .select()
    .from(documentEnvelopesTable)
    .where(eq(documentEnvelopesTable.id, envelopeId));

  if (!env) return { enqueued_fax_job_id: null, reason: "envelope_not_found" };
  if (!env.template_id) return { enqueued_fax_job_id: null, reason: "no_template_link" };

  const [tpl] = await db
    .select()
    .from(documentTemplatesTable)
    .where(eq(documentTemplatesTable.id, env.template_id));
  if (!tpl) return { enqueued_fax_job_id: null, reason: "template_deleted" };

  if (!tpl.triggers_med_records_request) {
    return { enqueued_fax_job_id: null, reason: "template_does_not_trigger_fax" };
  }

  const [lead] = await db.select().from(leadsTable).where(eq(leadsTable.id, env.lead_id));
  if (!lead) return { enqueued_fax_job_id: null, reason: "lead_not_found" };

  const targetFax = lead.hospital_fax || null;
  if (!targetFax) {
    await auditLog("lead", String(env.lead_id), "fax_skipped_no_target", {
      envelope_id: envelopeId,
      reason: "no_hospital_fax_on_lead",
    });
    return { enqueued_fax_job_id: null, reason: "no_target_fax" };
  }

  try {
    const jobId = await enqueueJob("fax_med_records_request", {
      lead_id: env.lead_id,
      envelope_id: envelopeId,
    });
    await auditLog("lead", String(env.lead_id), "fax_request_enqueued", {
      envelope_id: envelopeId,
      job_id: jobId,
      target_fax: targetFax,
    });
    return { enqueued_fax_job_id: jobId };
  } catch (err) {
    logger.error({ err, envelope_id: envelopeId }, "Failed to enqueue fax job");
    return {
      enqueued_fax_job_id: null,
      reason: `enqueue_error: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

// =============================================================================
// SMS follow-up — used by the review queue to nudge a lead via the active
// Telnyx SMS integration. Returns the queued job id (or null + reason).
//
// This wraps `enqueueJob("send_workflow_sms", …)` so the review-queue UI
// (and later, automated review-status transitions) can fire one call to
// schedule a deterministic, retryable SMS without owning the Telnyx
// adapter or job-queue contract themselves.
// =============================================================================
export async function enqueueLeadFollowUpSms(
  leadId: number,
  body: string,
  opts: { source?: string; firmId?: number | null } = {},
): Promise<{ job_id: number | null; reason?: string }> {
  if (!Number.isFinite(leadId) || leadId <= 0) {
    return { job_id: null, reason: "invalid_lead_id" };
  }
  const trimmed = body.trim();
  if (!trimmed) return { job_id: null, reason: "empty_body" };
  if (trimmed.length > 1600) return { job_id: null, reason: "body_too_long" };

  try {
    const jobId = await enqueueJob("send_workflow_sms", {
      lead_id: leadId,
      body: trimmed,
      firm_id: opts.firmId ?? null,
      source: opts.source ?? "workflow_engine",
    });
    await auditLog("lead", String(leadId), "sms_followup_enqueued", {
      job_id: jobId,
      source: opts.source ?? "workflow_engine",
      body_len: trimmed.length,
    });
    return { job_id: jobId };
  } catch (err) {
    logger.error({ err, lead_id: leadId }, "Failed to enqueue follow-up SMS");
    return {
      job_id: null,
      reason: `enqueue_error: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}
