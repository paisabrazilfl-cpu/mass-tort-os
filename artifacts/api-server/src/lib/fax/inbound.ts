/**
 * Inbound fax intake — closes the medical-records retrieval loop (Stage 4).
 *
 * A doctor's office faxes records back → the provider POSTs a webhook to
 * routes/webhooks.ts :: POST /webhooks/fax/:provider. That handler logs the
 * raw event into fax_events, then calls processInboundFax() here, which:
 *
 *   1. Confirms the event is an inbound *received* fax — not an outbound
 *      delivery-status callback for a fax WE sent.
 *   2. Downloads the received document, either from a media URL carried in
 *      the webhook payload or from inline base64 content.
 *   3. Correlates it to the originating claimant by matching the sender fax
 *      number against leads.hospital_fax (the number Stage 3 faxed TO).
 *   4. Stores it: a base64 vault file + a fax_results row + a documents row
 *      on the claimant's profile, and enqueues the process_fax OCR job
 *      (same pipeline as a manual /api/ocr/upload).
 *   5. Fires trigger.inbound_fax so the Stage-4 automation workflow runs.
 *
 * Honest bounds: the document is retrieved only when the webhook payload
 * carries a media URL or inline base64. Providers that require a separate
 * authenticated "fetch the file" call (e.g. SRFax Get_Fax) surface as
 * reason="no_document_in_payload" rather than being silently faked — the
 * raw fax_events row stays durable for manual retrieval.
 *
 * The pure classification + download logic lives in inbound-classify.ts
 * (no DB import) so it stays unit-testable without a database.
 */
import { db, pool, faxResultsTable, documentsTable, jobQueueTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { saveFile } from "../vault";
import { logger } from "../logger";
import { auditLog } from "../audit";
import { dispatchTrigger } from "../automations/dispatch";
import {
  deepFindString,
  isInboundReceivedEvent,
  retrieveDocument,
  FROM_KEYS,
} from "./inbound-classify";

export interface InboundFaxInput {
  provider: string;
  firmId: number | null;
  integrationId: number | null;
  externalFaxId: string | null;
  eventType: string;
  status: string | null;
  payload: Record<string, unknown>;
}

export interface InboundFaxResult {
  handled: boolean;
  reason?: string;
  lead_id?: number | null;
  fax_result_id?: number;
  vault_path?: string;
  document_id?: number;
}

// ── Claimant correlation ────────────────────────────────────────────────────

/**
 * Match an inbound fax to the claimant it belongs to by comparing the
 * sender fax number against leads.hospital_fax — the number Stage 3 faxed
 * the medical-records request TO. Compares the last 10 digits so it is
 * agnostic to formatting (+1, dashes, parens).
 *
 * When several claimants share one provider's fax number, the claimant
 * with the most recent outbound med-records request wins; that is the most
 * likely sender of an incoming reply.
 */
async function correlateLead(
  fromNumber: string,
  firmId: number | null,
): Promise<{ id: number; firm_id: number | null } | null> {
  const digits = fromNumber.replace(/\D/g, "");
  if (digits.length < 10) return null;
  const last10 = digits.slice(-10);

  const params: unknown[] = [last10];
  let firmClause = "";
  if (firmId != null) {
    params.push(firmId);
    firmClause = `AND firm_id = $${params.length}`;
  }
  const candidates = await pool.query<{ id: number; firm_id: number | null }>(
    `SELECT id, firm_id FROM leads
       WHERE length(regexp_replace(coalesce(hospital_fax,''), '[^0-9]', '', 'g')) >= 10
         AND right(regexp_replace(coalesce(hospital_fax,''), '[^0-9]', '', 'g'), 10) = $1
         ${firmClause}
       ORDER BY id DESC`,
    params,
  );
  if (candidates.rows.length === 0) return null;
  if (candidates.rows.length === 1) return candidates.rows[0]!;

  // Tie-break: the claimant with the most recent outbound med-records fax.
  const ids = candidates.rows.map((r) => r.id);
  const recent = await pool.query<{ lead_id: number }>(
    `SELECT lead_id FROM fax_results
       WHERE lead_id = ANY($1::int[])
         AND source_file LIKE 'med_records_request_%'
       ORDER BY created_at DESC
       LIMIT 1`,
    [ids],
  );
  const preferred = recent.rows[0]?.lead_id;
  return candidates.rows.find((r) => r.id === preferred) ?? candidates.rows[0]!;
}

// ── Orchestrator ────────────────────────────────────────────────────────────

/**
 * Process one inbound fax webhook. Never throws — always returns a result
 * object so the webhook route can stay a clean 200 OK.
 */
export async function processInboundFax(input: InboundFaxInput): Promise<InboundFaxResult> {
  try {
    if (!isInboundReceivedEvent(input.eventType, input.status, input.payload)) {
      return { handled: false, reason: "not_inbound_event" };
    }

    // 1. Retrieve the received document.
    let bytes: Buffer | null = null;
    try {
      bytes = await retrieveDocument(input.payload);
    } catch (err) {
      logger.warn(
        { err, provider: input.provider, externalFaxId: input.externalFaxId },
        "inbound fax: document retrieval failed",
      );
      return { handled: false, reason: "document_retrieval_failed" };
    }
    if (!bytes) {
      logger.warn(
        { provider: input.provider, externalFaxId: input.externalFaxId },
        "inbound fax: no media URL or inline content in webhook payload — needs manual retrieval",
      );
      return { handled: false, reason: "no_document_in_payload" };
    }

    // 2. Correlate to a claimant by sender fax number.
    const fromNumber = deepFindString(input.payload, FROM_KEYS) ?? "";
    const lead = fromNumber ? await correlateLead(fromNumber, input.firmId) : null;
    const leadId = lead?.id ?? null;

    // 3. Store: vault file (base64 — the format process_fax expects),
    //    fax_results row, and the OCR job.
    const stamp = input.externalFaxId || String(Date.now());
    const caseId = leadId ? `lead_${leadId}` : `fax_inbound_${stamp}`;
    const fileName = `inbound_fax_${stamp}.pdf`;
    const base64 = bytes.toString("base64");
    const { path: vaultPath } = await saveFile(caseId, base64, fileName);

    const sourceFile = leadId
      ? `inbound_med_records_lead_${leadId}_fax_${stamp}.pdf`
      : fileName;

    const [faxRow] = await db
      .insert(faxResultsTable)
      .values({
        source_file: sourceFile,
        vault_path: vaultPath,
        lead_id: leadId,
        status: "received",
      })
      .returning({ id: faxResultsTable.id });

    const [job] = await db
      .insert(jobQueueTable)
      .values({
        job_type: "process_fax",
        payload: {
          fax_result_id: faxRow!.id,
          vault_path: vaultPath,
          source_file: sourceFile,
          mime_type: "application/pdf",
        },
      })
      .returning({ id: jobQueueTable.id });

    await db
      .update(faxResultsTable)
      .set({ job_id: job!.id })
      .where(eq(faxResultsTable.id, faxRow!.id));

    // 4. Attach to the claimant's profile (documents.lead_id is NOT NULL +
    //    FK, so only when a claimant actually matched).
    let documentId: number | undefined;
    if (leadId) {
      const [doc] = await db
        .insert(documentsTable)
        .values({
          lead_id: leadId,
          document_type: "medical_records",
          file_name: fileName,
          file_url: vaultPath,
          notes: `Received via inbound fax from ${fromNumber || "unknown"} (${input.provider})`,
        })
        .returning({ id: documentsTable.id });
      documentId = doc?.id;
    }

    await auditLog("fax", String(faxRow!.id), "inbound_received", {
      provider: input.provider,
      external_fax_id: input.externalFaxId,
      from: fromNumber || null,
      lead_id: leadId,
      vault_path: vaultPath,
      document_id: documentId ?? null,
      bytes: bytes.length,
    });

    // 5. Fire the Stage-4 automation workflow. Only when a claimant was
    //    matched — the workflow's nodes (medical_extract / add_note) all
    //    need a lead context. Unmatched faxes stay in the fax inbox for the
    //    operator to assign manually.
    if (leadId) {
      dispatchTrigger("trigger.inbound_fax", {
        input: {
          lead_id: leadId,
          fax_result_id: faxRow!.id,
          documentId: vaultPath,
          document_id: documentId ?? null,
          vault_path: vaultPath,
          from: fromNumber || null,
          provider: input.provider,
          external_fax_id: input.externalFaxId,
        },
        firmId: lead?.firm_id ?? input.firmId ?? "any",
        source: "inbound_fax_webhook",
      }).catch((err) =>
        logger.error({ err, leadId }, "inbound fax: dispatchTrigger(trigger.inbound_fax) failed"),
      );
    } else {
      logger.warn(
        { provider: input.provider, from: fromNumber || null, externalFaxId: input.externalFaxId },
        "inbound fax: stored but no claimant matched on hospital_fax — left in inbox for manual assignment",
      );
    }

    return {
      handled: true,
      lead_id: leadId,
      fax_result_id: faxRow!.id,
      vault_path: vaultPath,
      document_id: documentId,
    };
  } catch (err) {
    logger.error({ err, provider: input.provider }, "inbound fax: processInboundFax crashed");
    return { handled: false, reason: "internal_error" };
  }
}
