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
import { db, pool, faxResultsTable, documentsTable, jobQueueTable, medicalRecordsRequestsTable } from "@workspace/db";
import { eq, and, inArray, desc } from "drizzle-orm";
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
  // A null firmId means the inbound-fax integration is not bound to a firm.
  // Matching leads.hospital_fax globally would let one firm's inbound fax
  // land on another firm's claimant — hospital records lines are widely
  // shared, so collisions are real, not hypothetical — a cross-tenant PHI
  // leak. Refuse to correlate; the fax stays an unassigned inbox item.
  if (firmId == null) return null;

  const digits = fromNumber.replace(/\D/g, "");
  if (digits.length < 10) return null;
  const last10 = digits.slice(-10);

  const candidates = await pool.query<{ id: number; firm_id: number | null }>(
    `SELECT id, firm_id FROM leads
       WHERE firm_id = $2
         AND length(regexp_replace(coalesce(hospital_fax,''), '[^0-9]', '', 'g')) >= 10
         AND right(regexp_replace(coalesce(hospital_fax,''), '[^0-9]', '', 'g'), 10) = $1
       ORDER BY id DESC`,
    [last10, firmId],
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

    // Provider-namespaced external id — the idempotency key. Namespacing by
    // provider avoids a cross-provider id collision.
    const externalKey = input.externalFaxId
      ? `${input.provider}:${input.externalFaxId}`
      : null;

    // Idempotency fast-path: fax providers re-deliver inbound webhooks
    // (sometimes with a different event_type each time, which slips past
    // the route-level externalId:eventType dedup). A cheap exact-match
    // lookup avoids re-downloading a fax we already stored. This is only
    // an optimization — the race-proof guarantee is the UNIQUE index on
    // fax_results.external_fax_id, enforced at INSERT time below.
    if (externalKey) {
      const seen = await pool.query(
        `SELECT 1 FROM fax_results WHERE external_fax_id = $1 LIMIT 1`,
        [externalKey],
      );
      if (seen.rows.length > 0) {
        return { handled: false, reason: "already_processed" };
      }
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
    // Prefix with a data: URI so worker.ts process_fax → detectMimeType()
    // routes this down the PDF text-extraction path (a bare base64 string
    // defaults to image/png). base64ToBuffer strips any data:<mime>;base64,
    // prefix before decoding.
    const base64 = `data:application/pdf;base64,${bytes.toString("base64")}`;
    const { path: vaultPath } = await saveFile(caseId, base64, fileName);

    const sourceFile = leadId
      ? `inbound_med_records_lead_${leadId}_fax_${stamp}.pdf`
      : fileName;

    // INSERT ... ON CONFLICT DO NOTHING on the unique external_fax_id index
    // is the race-proof idempotency guarantee: if a concurrent re-delivery
    // already inserted this fax, the conflict yields zero returned rows and
    // we stop before duplicating the job + documents rows.
    const inserted = await db
      .insert(faxResultsTable)
      .values({
        source_file: sourceFile,
        vault_path: vaultPath,
        lead_id: leadId,
        status: "received",
        external_fax_id: externalKey,
      })
      .onConflictDoNothing({ target: faxResultsTable.external_fax_id })
      .returning({ id: faxResultsTable.id });

    const faxRow = inserted[0];
    if (!faxRow) {
      logger.info(
        { provider: input.provider, externalFaxId: input.externalFaxId },
        "inbound fax: concurrent re-delivery lost the unique-index race — already processed",
      );
      return { handled: false, reason: "already_processed" };
    }

    const [job] = await db
      .insert(jobQueueTable)
      .values({
        job_type: "process_fax",
        payload: {
          fax_result_id: faxRow.id,
          vault_path: vaultPath,
          source_file: sourceFile,
          mime_type: "application/pdf",
        },
      })
      .returning({ id: jobQueueTable.id });

    await db
      .update(faxResultsTable)
      .set({ job_id: job!.id })
      .where(eq(faxResultsTable.id, faxRow.id));

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

    // 5. Mark the most recent outstanding MRR request for this lead as fulfilled.
    //    Uses a "most-recent-wins" heuristic: if multiple open requests exist
    //    for this claimant, the newest one is assumed to be the one answered.
    if (leadId) {
      try {
        const [openRequest] = await db
          .select({
            id: medicalRecordsRequestsTable.id,
            fax_result_id: medicalRecordsRequestsTable.fax_result_id,
          })
          .from(medicalRecordsRequestsTable)
          .where(
            and(
              eq(medicalRecordsRequestsTable.lead_id, leadId),
              inArray(medicalRecordsRequestsTable.status, ["sent", "pending"]),
            ),
          )
          .orderBy(desc(medicalRecordsRequestsTable.created_at))
          .limit(1);

        if (openRequest) {
          await db
            .update(medicalRecordsRequestsTable)
            .set({
              status: "fulfilled",
              fulfilled_at: new Date(),
              response_fax_result_id: faxRow.id,
              updated_at: new Date(),
            })
            .where(eq(medicalRecordsRequestsTable.id, openRequest.id));

          // Also mark the outbound fax as delivered so the poller stops and
          // the lead's fax timeline shows the confirmed-received status.
          if (openRequest.fax_result_id) {
            await db
              .update(faxResultsTable)
              .set({ delivery_status: "delivered", delivery_checked_at: new Date() })
              .where(eq(faxResultsTable.id, openRequest.fax_result_id));
          }
        }
      } catch (err) {
        // Non-fatal: don't let MRR update failure break the inbound fax pipeline.
        logger.warn({ err, leadId }, "inbound fax: failed to mark MRR request fulfilled");
      }
    }

    await auditLog("fax", String(faxRow.id), "inbound_received", {
      provider: input.provider,
      external_fax_id: input.externalFaxId,
      from: fromNumber || null,
      lead_id: leadId,
      vault_path: vaultPath,
      document_id: documentId ?? null,
      bytes: bytes.length,
    });

    // 6. Fire the Stage-4 automation workflow. Only when a claimant was
    //    matched — the workflow's nodes (medical_extract / add_note) all
    //    need a lead context. Unmatched faxes stay in the fax inbox for the
    //    operator to assign manually.
    if (leadId) {
      dispatchTrigger("trigger.inbound_fax", {
        input: {
          lead_id: leadId,
          fax_result_id: faxRow.id,
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
      fax_result_id: faxRow.id,
      vault_path: vaultPath,
      document_id: documentId,
    };
  } catch (err) {
    logger.error({ err, provider: input.provider }, "inbound fax: processInboundFax crashed");
    return { handled: false, reason: "internal_error" };
  }
}
