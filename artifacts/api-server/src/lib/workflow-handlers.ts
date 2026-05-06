/**
 * Job handlers for the document automation workflow.
 * Each handler is a self-contained async function that receives a payload
 * and either succeeds (worker marks done) or throws (worker marks failed + retries via job_queue.attempts).
 *
 * Handlers always:
 *  - Resolve the provider via provider-router (vendor-agnostic)
 *  - Persist a row in document_envelopes / fax_results so admin can audit
 *  - Use structured error returns from adapters; throw with a clear message on terminal errors
 */
import { db, leadsTable, documentTemplatesTable, documentEnvelopesTable, faxResultsTable } from "@workspace/db";
import { eq, and, sql } from "drizzle-orm";
import { logger } from "./logger";
import { auditLog } from "./audit";
import { resolveProvider, isResolved } from "./provider-router";
import { getEsignAdapter } from "./esign";
import { getFaxAdapter } from "./fax";
import { getEmailAdapter } from "./email/sendgrid";
import { downloadTemplate } from "./template-storage";
import { decryptLeadFields } from "./encryption";
import { FAX_SOURCE_FILE_TEMPLATE } from "./fax-results-matcher";

// pdf-lib is heavy (~830 KB with transitives) and only needed when
// buildTemplatePdf or buildMedRecordsCoverLetter actually run a job that
// produces a placeholder/cover-letter PDF. Lazy-loaded + externalized
// (see build.mjs) so worker boot doesn't pay for it.
type PdfLib = typeof import("pdf-lib");
let pdfLibModule: PdfLib | undefined;
async function loadPdfLib(): Promise<PdfLib> {
  if (!pdfLibModule) pdfLibModule = await import("pdf-lib");
  return pdfLibModule;
}

interface SendEsignPacketPayload {
  lead_id: number;
  template_id: number;
  envelope_id?: number;
  explicit_integration_id?: number | null;
}

interface FaxMedRecordsPayload {
  lead_id: number;
  envelope_id: number;
  explicit_integration_id?: number | null;
  /**
   * Optional ephemeral override for the destination fax number. When set,
   * the dispatch uses this value instead of `leads.hospital_fax` WITHOUT
   * persisting back to the lead row. Already-normalized E.164 expected
   * (callers should run `normalizeFaxNumber()` first). Used by the
   * `documents.fax_medical_records` automation node so an operator can
   * one-shot a different provider without overwriting the lead's fax.
   */
  override_fax?: string | null;
}

interface SendWorkflowEmailPayload {
  lead_id?: number;
  to: string;
  to_name?: string;
  subject: string;
  html: string;
  text?: string;
  explicit_integration_id?: number | null;
}

/**
 * Build the PDF for an envelope.
 *  - source="pdf"  → load the uploaded file from template-storage
 *  - source="ai"   → not yet implemented (returns a placeholder PDF + logs warning)
 */
async function buildTemplatePdf(template: typeof documentTemplatesTable.$inferSelect, lead: typeof leadsTable.$inferSelect): Promise<Buffer> {
  if (template.source === "pdf") {
    if (!template.storage_path) {
      throw new Error(`Template ${template.id} ("${template.name}") has source=pdf but no storage_path.`);
    }
    return await downloadTemplate(template.storage_path);
  }

  // AI-drafted templates fall back to a stub PDF until drafting-ai is wired.
  // We still send something rather than dropping the workflow on the floor.
  logger.warn(
    { template_id: template.id, lead_id: lead.id },
    "AI-drafted template requested but drafting-ai not yet implemented — sending placeholder PDF",
  );
  const { PDFDocument, StandardFonts, rgb } = await loadPdfLib();
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([612, 792]);
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  page.drawText(template.name, { x: 50, y: 740, size: 20, font, color: rgb(0, 0, 0) });
  page.drawText(`Lead: ${lead.name || `${lead.first_name ?? ""} ${lead.last_name ?? ""}`.trim()}`, {
    x: 50,
    y: 700,
    size: 12,
    font,
  });
  page.drawText(`Tort: ${lead.tort_type}`, { x: 50, y: 680, size: 12, font });
  page.drawText("(AI drafting not yet implemented — placeholder body.)", {
    x: 50,
    y: 640,
    size: 10,
    font,
    color: rgb(0.4, 0.4, 0.4),
  });
  const bytes = await pdf.save();
  return Buffer.from(bytes);
}

/**
 * Build a plain medical-records-request cover letter PDF.
 * Includes the signed HIPAA reference (envelope_id) so the doctor's office can verify.
 */
async function buildMedRecordsCoverLetter(lead: typeof leadsTable.$inferSelect, envelopeId: number): Promise<Buffer> {
  const { PDFDocument, StandardFonts } = await loadPdfLib();
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([612, 792]);
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);

  let y = 740;
  page.drawText("REQUEST FOR MEDICAL RECORDS", { x: 50, y, size: 18, font: bold });
  y -= 40;
  page.drawText(`Date: ${new Date().toLocaleDateString()}`, { x: 50, y, size: 11, font });
  y -= 30;
  page.drawText("To Whom It May Concern,", { x: 50, y, size: 11, font });
  y -= 25;
  const patientName = lead.name || `${lead.first_name ?? ""} ${lead.last_name ?? ""}`.trim() || "Patient";
  const lines = [
    `Please provide all medical records for the patient named below, in connection with`,
    `their representation in mass tort litigation. A signed HIPAA authorization is on file`,
    `(envelope reference: ${envelopeId}) and is available upon request.`,
    "",
    `Patient name:       ${patientName}`,
    `Date of birth:      ${lead.date_of_birth ?? "—"}`,
    `Last 4 SSN:         ${lead.last_4_ssn ?? "—"}`,
    `Diagnosis:          ${lead.diagnosis ?? lead.diagnosis_type ?? "—"}`,
    `Diagnosis date:     ${lead.diagnosis_date ?? "—"}`,
    `Treating physician: ${[lead.physician_first_name, lead.physician_last_name].filter(Boolean).join(" ") || "—"}`,
    "",
    "Please return the records by reply fax or by mail to the address on file.",
    "Thank you for your prompt attention.",
  ];
  for (const ln of lines) {
    page.drawText(ln, { x: 50, y, size: 11, font });
    y -= 16;
  }

  const bytes = await pdf.save();
  return Buffer.from(bytes);
}

/**
 * Resolve the lead's signer info (decrypted name + email).
 * Returns null if no usable signer email is on file — handler will record a clear error.
 */
export function getSignerFromLead(lead: typeof leadsTable.$inferSelect): { name: string; email: string } | null {
  const decrypted = decryptLeadFields(lead);
  const email = decrypted.email;
  if (!email || typeof email !== "string") return null;
  const name = (decrypted.name as string)
    || `${decrypted.first_name ?? ""} ${decrypted.last_name ?? ""}`.trim()
    || "Lead";
  return { name, email };
}

// ────────────────────────────────────────────────────────────────────────────
// HANDLER: send_esign_packet
// ────────────────────────────────────────────────────────────────────────────

export async function handleSendEsignPacket(payload: SendEsignPacketPayload): Promise<void> {
  const { lead_id, template_id, explicit_integration_id } = payload;

  const [lead] = await db.select().from(leadsTable).where(eq(leadsTable.id, lead_id));
  if (!lead) throw new Error(`Lead ${lead_id} not found`);

  const [tpl] = await db.select().from(documentTemplatesTable).where(eq(documentTemplatesTable.id, template_id));
  if (!tpl) throw new Error(`Template ${template_id} not found`);

  const signer = getSignerFromLead(lead);
  if (!signer) {
    await auditLog("lead", String(lead_id), "esign_dispatch_failed", {
      template_id,
      reason: "no_signer_email",
    });
    throw new Error(`Lead ${lead_id} has no email — cannot send e-sign packet "${tpl.name}".`);
  }

  // Atomic idempotency guard + reservation.
  // Run the duplicate-check and the reservation insert inside a single transaction
  // with an advisory lock keyed on (lead_id, template_id) so concurrent worker
  // executions cannot both insert. If a live envelope already exists, skip.
  const reservation = await db.transaction(async (tx) => {
    // Postgres advisory transaction lock on (lead_id, template_id) — auto-released on commit/rollback.
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext(${'esign:lead:' + String(lead_id) + ':tpl:' + String(template_id)}))`,
    );
    const existing = await tx
      .select({ id: documentEnvelopesTable.id, status: documentEnvelopesTable.status })
      .from(documentEnvelopesTable)
      .where(
        and(
          eq(documentEnvelopesTable.lead_id, lead_id),
          eq(documentEnvelopesTable.template_id, template_id),
        ),
      );
    // Stale-reservation reclaim: if the only "live" row is a queued+pending reservation
    // older than 15 minutes (worker crashed between insert and provider call), mark it
    // reclaimed so we can safely create a fresh envelope and dispatch.
    const STALE_RESERVATION_MS = 15 * 60 * 1000;
    const now = Date.now();
    const fullExisting = await tx
      .select()
      .from(documentEnvelopesTable)
      .where(
        and(
          eq(documentEnvelopesTable.lead_id, lead_id),
          eq(documentEnvelopesTable.template_id, template_id),
        ),
      );
    const live = fullExisting.find((e) => {
      if (e.status === "error" || e.status === "voided") return false;
      // Treat as stale (and therefore not blocking) if it's still a pending reservation
      // with no provider envelope id and is older than the threshold.
      const createdAt = e.created_at ? new Date(e.created_at).getTime() : now;
      const isStaleReservation =
        e.status === "queued" &&
        (e.provider === "pending" || !e.external_envelope_id) &&
        now - createdAt > STALE_RESERVATION_MS;
      return !isStaleReservation;
    });
    if (live) {
      return { skipped: true as const, existing: { id: live.id, status: live.status } };
    }
    // Reclaim any stale reservations so they don't accumulate.
    for (const stale of fullExisting) {
      if (
        stale.status === "queued" &&
        (stale.provider === "pending" || !stale.external_envelope_id)
      ) {
        await tx
          .update(documentEnvelopesTable)
          .set({
            status: "error",
            last_error: "Stale reservation reclaimed (worker likely crashed before dispatch).",
            updated_at: new Date(),
          })
          .where(eq(documentEnvelopesTable.id, stale.id));
      }
    }
    const [row] = await tx
      .insert(documentEnvelopesTable)
      .values({
        lead_id,
        template_id,
        provider: "pending",
        status: "queued",
        signer_name: signer.name,
        signer_email: signer.email,
        sent_at: null,
        events: [{ type: "queued", at: new Date().toISOString() }],
        metadata: { explicit_integration_id: explicit_integration_id ?? null },
      })
      .returning();
    return { skipped: false as const, envelope: row };
  });

  if (reservation.skipped) {
    logger.info(
      { lead_id, template_id, envelope_id: reservation.existing.id, status: reservation.existing.status },
      "handleSendEsignPacket: envelope already exists for (lead, template) — skipping duplicate dispatch",
    );
    await auditLog("document_envelope", String(reservation.existing.id), "duplicate_dispatch_skipped", {
      lead_id, template_id, existing_status: reservation.existing.status,
    });
    return;
  }
  const envelope = reservation.envelope;

  const resolved = await resolveProvider("esign", {
    buyerId: lead.buyer_id ?? null,
    explicitIntegrationId: explicit_integration_id ?? null,
  });

  if (!isResolved(resolved)) {
    await db
      .update(documentEnvelopesTable)
      .set({
        status: "error",
        last_error: `Provider resolution failed: ${resolved.reason} — ${resolved.details ?? ""}`,
        updated_at: new Date(),
      })
      .where(eq(documentEnvelopesTable.id, envelope.id));
    await auditLog("document_envelope", String(envelope.id), "provider_resolution_failed", {
      reason: resolved.reason,
      details: resolved.details,
    });
    throw new Error(`No e-sign provider configured (${resolved.reason}). Pick one on the Workflow Settings page.`);
  }

  const adapter = getEsignAdapter(resolved.provider);
  if (!adapter) {
    await db
      .update(documentEnvelopesTable)
      .set({
        provider: resolved.provider,
        provider_integration_id: resolved.integration_id,
        status: "error",
        last_error: `No adapter implemented for provider "${resolved.provider}".`,
        updated_at: new Date(),
      })
      .where(eq(documentEnvelopesTable.id, envelope.id));
    throw new Error(`No e-sign adapter wired for provider "${resolved.provider}".`);
  }

  let pdfBuf: Buffer;
  try {
    pdfBuf = await buildTemplatePdf(tpl, lead);
  } catch (err) {
    await db
      .update(documentEnvelopesTable)
      .set({
        provider: resolved.provider,
        provider_integration_id: resolved.integration_id,
        status: "error",
        last_error: `Could not load/build template PDF: ${(err as Error).message}`,
        updated_at: new Date(),
      })
      .where(eq(documentEnvelopesTable.id, envelope.id));
    throw err;
  }

  let outcome;
  try {
    outcome = await adapter.send(resolved.credentials, {
      pdf: pdfBuf,
      fileName: `${tpl.name}.pdf`,
      subject: tpl.delivery_subject || `Please sign: ${tpl.name}`,
      message: tpl.delivery_message || "Please review and sign the attached document.",
      signers: [{ name: signer.name, email: signer.email, role: tpl.signer_role }],
      metadata: {
        lead_id: String(lead_id),
        template_id: String(template_id),
        envelope_id: String(envelope.id),
      },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await db
      .update(documentEnvelopesTable)
      .set({
        provider: resolved.provider,
        provider_integration_id: resolved.integration_id,
        status: "error",
        last_error: `Adapter threw: ${msg}`,
        updated_at: new Date(),
      })
      .where(eq(documentEnvelopesTable.id, envelope.id));
    await auditLog("document_envelope", String(envelope.id), "adapter_threw", { provider: resolved.provider, error: msg });
    throw new Error(`E-sign adapter ${resolved.provider} threw: ${msg}`);
  }

  if (!outcome.ok) {
    await db
      .update(documentEnvelopesTable)
      .set({
        provider: resolved.provider,
        provider_integration_id: resolved.integration_id,
        status: outcome.retryable ? "queued" : "error",
        last_error: `[${outcome.code}] ${outcome.message}`,
        updated_at: new Date(),
        events: [
          { type: "queued", at: new Date(Date.now() - 1000).toISOString() },
          { type: outcome.retryable ? "retryable_error" : "fatal_error", at: new Date().toISOString(), raw: { code: outcome.code, message: outcome.message } },
        ],
      })
      .where(eq(documentEnvelopesTable.id, envelope.id));
    await auditLog("document_envelope", String(envelope.id), "provider_send_failed", {
      provider: resolved.provider,
      code: outcome.code,
      message: outcome.message,
      retryable: outcome.retryable,
      severity: outcome.retryable ? "medium" : "high",
      lead_id,
      template_id,
    });
    if (outcome.retryable) {
      throw new Error(`Provider transient error: ${outcome.message}`);
    }
    // Non-retryable: do NOT throw — letting the worker mark the job done
    // prevents an endless retry loop on a permanent failure (bad creds,
    // invalid signer email, etc). But it MUST be loud — otherwise the
    // workflow silently stalls and operators have no idea.
    logger.error(
      {
        envelope_id: envelope.id,
        lead_id,
        template_id,
        provider: resolved.provider,
        code: outcome.code,
        message: outcome.message,
      },
      "E-sign provider returned NON-RETRYABLE failure — envelope marked error, audit recorded, workflow halted",
    );
    return;
  }

  await db
    .update(documentEnvelopesTable)
    .set({
      provider: resolved.provider,
      provider_integration_id: resolved.integration_id,
      external_envelope_id: outcome.externalEnvelopeId,
      status: "sent",
      sent_at: new Date(),
      events: [
        { type: "queued", at: new Date(Date.now() - 1000).toISOString() },
        { type: "sent", at: new Date().toISOString(), raw: { external_envelope_id: outcome.externalEnvelopeId } },
      ],
      updated_at: new Date(),
    })
    .where(eq(documentEnvelopesTable.id, envelope.id));

  await auditLog("document_envelope", String(envelope.id), "sent", {
    provider: resolved.provider,
    external_envelope_id: outcome.externalEnvelopeId,
    template: tpl.name,
    signer: signer.email,
  });

  logger.info(
    { envelope_id: envelope.id, lead_id, template_id, provider: resolved.provider, external_id: outcome.externalEnvelopeId },
    "E-sign packet sent",
  );
}

// ────────────────────────────────────────────────────────────────────────────
// HANDLER: fax_med_records_request
// ────────────────────────────────────────────────────────────────────────────

export interface FaxMedRecordsResult {
  ok: boolean;
  faxResultId: number;
  externalFaxId: string | null;
  status: "done" | "error";
  provider: string | null;
  to: string | null;
  errorCode?: string;
  errorMessage?: string;
}

/**
 * Pre-creates a fax_results row in "error" state so the lead's "Doctor
 * Faxes" timeline shows the failed attempt even when we can't reach the
 * adapter. Returns the row id for the caller to surface.
 */
async function recordFaxFailure(
  leadId: number,
  envelopeId: number,
  errorCode: string,
  errorMessage: string,
): Promise<number> {
  const [row] = await db
    .insert(faxResultsTable)
    .values({
      source_file: FAX_SOURCE_FILE_TEMPLATE(leadId, envelopeId),
      vault_path: "outbound:med_records_request",
      status: "error",
      raw_text: `[${errorCode}] ${errorMessage}`,
      processed_at: new Date(),
    })
    .returning();
  await auditLog("fax", String(row.id), "send_failed_preflight", {
    lead_id: leadId,
    envelope_id: envelopeId,
    code: errorCode,
    message: errorMessage,
  });
  return row.id;
}

export async function handleFaxMedRecordsRequest(payload: FaxMedRecordsPayload): Promise<FaxMedRecordsResult> {
  const { lead_id, envelope_id, explicit_integration_id, override_fax } = payload;

  const [lead] = await db.select().from(leadsTable).where(eq(leadsTable.id, lead_id));
  if (!lead) throw new Error(`Lead ${lead_id} not found`);

  // Caller-supplied override takes precedence but is NEVER persisted —
  // this is an ephemeral one-shot dispatch path.
  const targetFax = override_fax || lead.hospital_fax;
  if (!targetFax) {
    const id = await recordFaxFailure(lead_id, envelope_id, "no_fax_on_file", "Lead has no hospital_fax on file");
    throw new Error(`Lead ${lead_id} has no hospital_fax on file — cannot send fax. (fax_results.id=${id})`);
  }

  const resolved = await resolveProvider("fax", {
    buyerId: lead.buyer_id ?? null,
    explicitIntegrationId: explicit_integration_id ?? null,
  });

  if (!isResolved(resolved)) {
    await auditLog("lead", String(lead_id), "fax_dispatch_failed", {
      envelope_id,
      reason: resolved.reason,
      details: resolved.details,
    });
    const id = await recordFaxFailure(lead_id, envelope_id, "no_provider", `No fax provider configured (${resolved.reason})`);
    throw new Error(`No fax provider configured (${resolved.reason}). Pick one on the Workflow Settings page. (fax_results.id=${id})`);
  }

  const adapter = getFaxAdapter(resolved.provider);
  if (!adapter) {
    const id = await recordFaxFailure(lead_id, envelope_id, "no_adapter", `No fax adapter wired for provider "${resolved.provider}"`);
    throw new Error(`No fax adapter wired for provider "${resolved.provider}". (fax_results.id=${id})`);
  }

  const coverPdf = await buildMedRecordsCoverLetter(lead, envelope_id);

  // Pre-insert a pending fax_results row so admins see the attempt even if the call fails.
  const [faxRow] = await db
    .insert(faxResultsTable)
    .values({
      // Single source of truth for the source_file convention. The read API
      // (`/api/leads/:id/fax-results`) parses against this same template via
      // `buildFaxResultsLikePattern`, so producer/consumer can never drift.
      source_file: FAX_SOURCE_FILE_TEMPLATE(lead_id, envelope_id),
      vault_path: "outbound:med_records_request",
      status: "processing",
    })
    .returning();

  let outcome;
  try {
    outcome = await adapter.send(resolved.credentials, {
      pdf: coverPdf,
      fileName: `med_records_request_${envelope_id}.pdf`,
      toNumber: targetFax,
      metadata: {
        lead_id: String(lead_id),
        envelope_id: String(envelope_id),
      },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await db
      .update(faxResultsTable)
      .set({ status: "error", raw_text: `Adapter threw: ${msg}`, processed_at: new Date() })
      .where(eq(faxResultsTable.id, faxRow.id));
    await auditLog("fax", String(faxRow.id), "adapter_threw", { lead_id, envelope_id, provider: resolved.provider, error: msg });
    throw new Error(`Fax adapter ${resolved.provider} threw: ${msg}`);
  }

  if (!outcome.ok) {
    await db
      .update(faxResultsTable)
      .set({
        status: "error",
        raw_text: `[${outcome.code}] ${outcome.message}`,
        processed_at: new Date(),
      })
      .where(eq(faxResultsTable.id, faxRow.id));
    await auditLog("fax", String(faxRow.id), "send_failed", {
      lead_id,
      envelope_id,
      provider: resolved.provider,
      code: outcome.code,
      message: outcome.message,
      retryable: outcome.retryable,
    });
    // Embed `fax_results.id=...` in the throw message so the executor's
    // catch path can parse it back out and surface `fax_results_id` in the
    // failed branch payload — same convention used by the preflight throws
    // above. Without this the timeline shows the error row but the
    // automation node loses the back-reference.
    if (outcome.retryable) {
      throw new Error(`Fax provider transient error: ${outcome.message} (fax_results.id=${faxRow.id})`);
    }
    // Non-retryable provider failures are still failures — surface them so
    // automation/job callers can branch and so the operator sees an error
    // (not a misleading "sent") in the timeline.
    throw new Error(`Fax provider rejected request: [${outcome.code}] ${outcome.message} (fax_results.id=${faxRow.id})`);
  }

  await db
    .update(faxResultsTable)
    .set({
      status: "done",
      raw_text: `Sent to ${targetFax} via ${resolved.provider} — external_id=${outcome.externalFaxId}`,
      processed_at: new Date(),
    })
    .where(eq(faxResultsTable.id, faxRow.id));

  await auditLog("fax", String(faxRow.id), "sent", {
    lead_id,
    envelope_id,
    to: targetFax,
    provider: resolved.provider,
    external_fax_id: outcome.externalFaxId,
  });

  logger.info(
    { fax_id: faxRow.id, lead_id, envelope_id, provider: resolved.provider, external_id: outcome.externalFaxId, to: targetFax },
    "Med records fax sent",
  );

  return {
    ok: true,
    faxResultId: faxRow.id,
    externalFaxId: outcome.externalFaxId,
    status: "done",
    provider: resolved.provider,
    to: targetFax,
  };
}

// ────────────────────────────────────────────────────────────────────────────
// HANDLER: send_workflow_email
// ────────────────────────────────────────────────────────────────────────────

export async function handleSendWorkflowEmail(payload: SendWorkflowEmailPayload): Promise<void> {
  const { to, to_name, subject, html, text, explicit_integration_id, lead_id } = payload;

  const buyerId = lead_id
    ? (await db.select({ b: leadsTable.buyer_id }).from(leadsTable).where(eq(leadsTable.id, lead_id)))[0]?.b ?? null
    : null;

  const resolved = await resolveProvider("email", {
    buyerId,
    explicitIntegrationId: explicit_integration_id ?? null,
  });

  if (!isResolved(resolved)) {
    throw new Error(`No email provider configured (${resolved.reason}). Pick one on the Workflow Settings page.`);
  }

  const adapter = getEmailAdapter(resolved.provider);
  if (!adapter) {
    throw new Error(`No email adapter wired for provider "${resolved.provider}".`);
  }

  const fromEmail = (resolved.credentials as Record<string, unknown>).from_email as string | undefined
    || "noreply@example.com";
  const fromName = (resolved.credentials as Record<string, unknown>).from_name as string | undefined
    || "MTOS";

  let outcome;
  try {
    outcome = await adapter.send(resolved.credentials, {
      to,
      toName: to_name,
      fromEmail,
      fromName,
      subject,
      html,
      text,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ err, to, subject, provider: resolved.provider }, "Email adapter threw");
    throw new Error(`Email adapter ${resolved.provider} threw: ${msg}`);
  }

  if (!outcome.ok) {
    if (outcome.retryable) throw new Error(`Email provider transient error: ${outcome.message}`);
    logger.error({ to, code: outcome.code, message: outcome.message }, "Email send failed (non-retryable)");
    return;
  }

  logger.info({ to, subject, provider: resolved.provider, external_id: outcome.externalMessageId }, "Workflow email sent");
}

// =============================================================================
// SMS workflow handler — used by review-queue follow-up automation. Reads
// the lead's encrypted phone, sends via the active Telnyx SMS integration,
// and persists an `sms_messages` row keyed to the lead/firm so the
// delivery webhook can update its status.
// =============================================================================

interface SendWorkflowSmsPayload {
  lead_id: number;
  body: string;
  firm_id?: number | null;
  source?: string; // e.g. "review_queue_follow_up"
}

export async function handleSendWorkflowSms(payload: SendWorkflowSmsPayload): Promise<void> {
  const { sendSms } = await import("./sms/telnyx");

  const [lead] = await db
    .select()
    .from(leadsTable)
    .where(eq(leadsTable.id, payload.lead_id));
  if (!lead) {
    logger.warn({ lead_id: payload.lead_id }, "send_workflow_sms: lead not found");
    return;
  }
  const decrypted = decryptLeadFields(lead, String(lead.id));
  const phone = typeof decrypted.phone === "string" ? decrypted.phone.trim() : "";
  if (!phone) {
    logger.warn({ lead_id: payload.lead_id }, "send_workflow_sms: lead has no phone — skipping");
    return;
  }

  const firmId = payload.firm_id ?? lead.firm_id ?? null;
  const result = await sendSms({
    to: phone,
    body: payload.body,
    firmId,
    leadId: payload.lead_id,
  });

  if (!result.ok) {
    // Persistent provider error → throw so worker retries up to job_queue.attempts.
    throw new Error(`telnyx send failed: ${result.error ?? "unknown"}`);
  }
  logger.info(
    { lead_id: payload.lead_id, sms_message_id: result.smsMessageId, source: payload.source ?? null },
    "Workflow SMS sent",
  );
}
