/**
 * MTOS Distributed Worker
 * Polls the PostgreSQL job_queue table and processes jobs.
 * Runs as a separate process — started via "pnpm run worker" command.
 */
import {
  db, casesTable, caseDocumentsTable, analysisTable, faxResultsTable, reviewQueueTable,
  dialerCampaignsTable, dialerCampaignLeadsTable, dialerDncTable, callLogsTable, leadsTable,
} from "@workspace/db";
import { getFaxAdapter } from "./lib/fax";
import { eq, and, or, asc, inArray, sql } from "drizzle-orm";
import { logger } from "./lib/logger";
import { claimNextJob, markJobDone, markJobFailed, reclaimStaleProcessingJobs, enqueueJob } from "./lib/queue";
import { resolveProvider, isResolved } from "./lib/provider-router";
import { saveFile, readFile, listCaseFiles } from "./lib/vault";
import { extractFeatures } from "./lib/ai-extract";
import { scoreFeatures, scoreToVerdict } from "./lib/scoring";
import { auditLog } from "./lib/audit";
import { preprocessFaxBuffer, base64ToBuffer, detectMimeType } from "./lib/ocr-preprocess";
import { extractOcrData, extractOcrDataFromText } from "./lib/ai-ocr";
import { extractPdfText } from "./lib/pdf-extract";
import { decrypt } from "./lib/encryption";
import { withErrorFallback, createLoopGuard, DEFAULT_LIMITS } from "./lib/error-fallback";
import { handleSendEsignPacket, handleFaxMedRecordsRequest, handleSendWorkflowEmail, handleSendWorkflowSms } from "./lib/workflow-handlers";
import { handleFastenRecordsSync, auditStaleFastenPartials } from "./lib/fasten-job";
import { handleCompetitiveIntelSync, type CompetitiveIntelSyncPayload } from "./lib/competitive-intel-sync";
import { ensureSystemUser } from "./lib/case-ownership-backfill";
import { dispatchEvent } from "./lib/event-dispatcher";
import { updateCaseStatus } from "./lib/case-status";

const POLL_INTERVAL_MS = 2000;

// UUID v4-ish format we issue from `crypto.randomUUID()` (cases.ts route).
// Anything else in `case_id` is a bug or hostile input — we refuse to process it
// instead of letting it loop through the retry policy.
const CASE_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Marker thrown by job handlers for payloads that can never succeed
 * (null/undefined IDs, schema-violating shapes, path-traversal attempts,
 *  empty payloads, etc).  The worker loop catches this and dead-letters
 *  the job IMMEDIATELY instead of burning all 5 retries.
 */
class NonRetryableJobError extends Error {
  readonly nonRetryable = true as const;
  constructor(message: string) {
    super(message);
    this.name = "NonRetryableJobError";
  }
}

function assertCaseId(case_id: unknown): asserts case_id is string {
  if (typeof case_id !== "string" || case_id.length === 0) {
    throw new NonRetryableJobError(
      `Invalid payload: case_id is required and must be a string (got ${typeof case_id})`,
    );
  }
  if (!CASE_ID_RE.test(case_id)) {
    throw new NonRetryableJobError(
      `Invalid payload: case_id "${case_id}" is not a valid UUID — refusing to process (potential injection / poison-pill)`,
    );
  }
}

async function processJob(job: {
  id: number;
  job_type: string;
  payload: unknown;
}) {
  // Defensive: claimNextJob enforces NOT NULL but a hand-edited / legacy row
  // could still land here with `payload: null` or a JSON literal `null`.
  // Treat anything that isn't a plain object as a poison pill.
  if (!job.payload || typeof job.payload !== "object" || Array.isArray(job.payload)) {
    throw new NonRetryableJobError(
      `Invalid payload: expected object, got ${Array.isArray(job.payload) ? "array" : typeof job.payload}`,
    );
  }
  const payload = job.payload as Record<string, unknown>;
  logger.info({ job_id: job.id, job_type: job.job_type }, "Processing job");

  if (job.job_type === "create_case") {
    const { case_id, data, created_by_user_id } = payload as {
      case_id: unknown;
      data: unknown;
      created_by_user_id?: unknown;
    };
    assertCaseId(case_id);
    if (data !== undefined && data !== null && (typeof data !== "object" || Array.isArray(data))) {
      throw new NonRetryableJobError(
        `Invalid payload: data must be an object or null (got ${Array.isArray(data) ? "array" : typeof data})`,
      );
    }
    // RBAC ownership: the API enqueues `created_by_user_id` from req.user.id.
    // Post-Task #22 the column is NOT NULL, so we can no longer accept a
    // null/undefined value without dead-lettering. Instead we fall back to
    // the designated "system" backfill user — same identity Task #22's
    // historical-row backfill used. That keeps queued rows from older API
    // builds (and dev-mode requests where req.user.id is 0) processable
    // without leaking those rows to a real viewer.
    const isRealUserId =
      typeof created_by_user_id === "number" && Number.isInteger(created_by_user_id) && created_by_user_id > 0;
    const ownerUserId = isRealUserId ? created_by_user_id : await ensureSystemUser();
    await db
      .insert(casesTable)
      .values({
        id: case_id,
        data: (data as Record<string, unknown>) ?? {},
        status: "open",
        created_by_user_id: ownerUserId,
      })
      .onConflictDoNothing();
    await auditLog("case", case_id, "created", { data: data ?? {}, created_by_user_id: ownerUserId });
    logger.info({ case_id, created_by_user_id: ownerUserId }, "Case created");
  } else if (job.job_type === "ingest_file") {
    const { case_id, file_name, content, content_type } = payload as {
      case_id: unknown;
      file_name: unknown;
      content: unknown;
      content_type?: unknown;
    };
    assertCaseId(case_id);
    if (typeof file_name !== "string" || file_name.length === 0) {
      throw new NonRetryableJobError("Invalid payload: file_name is required");
    }
    if (typeof content !== "string" || content.length === 0) {
      throw new NonRetryableJobError("Invalid payload: content is required");
    }
    const ct = typeof content_type === "string" ? content_type : "text/plain";
    const { path, hash, sizeBytes } = await saveFile(case_id, content, file_name);
    await db.insert(caseDocumentsTable).values({
      case_id,
      path,
      file_hash: hash,
      file_name,
      content_type: ct,
    });
    await auditLog("case_document", case_id, "file_ingested", { file_name, hash, sizeBytes });
    logger.info({ case_id, path, sizeBytes }, "File ingested to vault");
  } else if (job.job_type === "analyze_case") {
    const { case_id } = payload as { case_id: unknown };
    assertCaseId(case_id);

    const docs = await db
      .select()
      .from(caseDocumentsTable)
      .where(eq(caseDocumentsTable.case_id, case_id));

    if (docs.length === 0) {
      logger.warn({ case_id }, "No documents to analyze");
      return;
    }

    const loopGuard = createLoopGuard(DEFAULT_LIMITS);
    let successCount = 0;
    let failCount = 0;

    for (const doc of docs) {
      if (!loopGuard.canRetry() && failCount > 0) {
        await auditLog("case_analysis", case_id, "LOOP_ABORTED", {
          reason: "Loop guard limits exceeded",
          state: loopGuard.getState(),
        });
        logger.error({ case_id }, "LOOP_ABORTED — forced exit from analysis loop");
        break;
      }

      const result = await withErrorFallback(
        async (_input, attempt) => {
          let text = "";
          try {
            text = await readFile(doc.path);
          } catch (err) {
            throw new Error(`Could not read vault file ${doc.path}: ${err}`);
          }

          const features = await extractFeatures(text);
          const score = scoreFeatures(features);
          const verdict = scoreToVerdict(score);

          if (attempt > 0) {
            loopGuard.recordAIRecheck();
          }

          await db.insert(analysisTable).values({
            case_id,
            features: features as Record<string, unknown>,
            score,
            ai_model: "claude-haiku-4-5",
            raw_text_length: text.length,
          });

          await auditLog("analysis", case_id, "analyzed", {
            file: doc.file_name,
            score,
            verdict,
            features,
            attempt: attempt + 1,
          });

          logger.info({ case_id, score, verdict }, "Analysis complete");
          return { score, verdict, features };
        },
        { case_id, file: doc.file_name },
        {
          entity_type: "case_analysis",
          entity_id: case_id,
          source_module: "worker_analyze_case",
          failsafe_mode: "REVIEW_FAIL",
        }
      );

      if (result.success) {
        successCount++;
      } else {
        failCount++;
        loopGuard.recordRetry();
        logger.error(
          { case_id, file: doc.file_name, output_state: result.output_state },
          "Analysis failed — routed to review queue"
        );
      }
    }

    const finalStatus = failCount === docs.length ? "review_required" : "analyzed";
    // All case status mutations go through updateCaseStatus so the
    // audit row + case.stage_changed event are guaranteed in lockstep
    // — see lib/case-status.ts for the contract.
    await updateCaseStatus({
      case_id,
      new_status: finalStatus,
      changed_by: "worker",
      context: {
        total_docs: docs.length,
        success_count: successCount,
        fail_count: failCount,
      },
      source: "worker:analyze_case",
    });

    if (finalStatus === "review_required") {
      await auditLog("case", case_id, "analysis_failed", {
        total_docs: docs.length,
        success_count: successCount,
        fail_count: failCount,
      });
    }
  } else if (job.job_type === "process_fax") {
    const { fax_result_id, vault_path, source_file, mime_type } = payload as {
      fax_result_id: number;
      vault_path: string;
      source_file: string;
      mime_type: string;
    };

    await db
      .update(faxResultsTable)
      .set({ status: "processing" })
      .where(eq(faxResultsTable.id, fax_result_id));

    const faxResult = await withErrorFallback(
      async (_input, attempt) => {
        const rawBase64 = await readFile(vault_path);
        const rawBuffer = base64ToBuffer(rawBase64);
        const detectedMime = detectMimeType(rawBase64) || mime_type;

        // PDFs cannot be processed by the vision model — extract text first,
        // then analyse with the text-based OCR path.
        let grid;
        if (detectedMime === "application/pdf" || detectedMime === "application/x-pdf") {
          logger.info({ fax_result_id, vault_path }, "Fax is a PDF — extracting text");
          const pdfText = await extractPdfText(rawBuffer);
          grid = await extractOcrDataFromText(pdfText);
        } else {
          const processedBuffer = await preprocessFaxBuffer(rawBuffer);
          const processedBase64 = processedBuffer.toString("base64");
          grid = await extractOcrData(processedBase64, detectedMime);
        }

        await db
          .update(faxResultsTable)
          .set({
            rx_number: grid.rx_number,
            drug_name: grid.drug_name,
            fill_date: grid.fill_date,
            quantity: grid.quantity,
            confidence: grid.confidence,
            raw_text: grid.raw_text,
            status: "done",
            processed_at: new Date(),
          })
          .where(eq(faxResultsTable.id, fax_result_id));

        await auditLog("fax", String(fax_result_id), "processed", {
          source_file,
          drug_name: grid.drug_name,
          confidence: grid.confidence,
          attempt: attempt + 1,
        });

        logger.info(
          { fax_result_id, drug_name: grid.drug_name, confidence: grid.confidence },
          "Fax OCR complete"
        );
        return grid;
      },
      { fax_result_id, vault_path, source_file },
      {
        entity_type: "fax_ocr",
        entity_id: String(fax_result_id),
        source_module: "worker_process_fax",
        failsafe_mode: "REVIEW_FAIL",
      }
    );

    if (!faxResult.success) {
      await db
        .update(faxResultsTable)
        .set({ status: "error", processed_at: new Date() })
        .where(eq(faxResultsTable.id, fax_result_id));
      logger.error({ fax_result_id, output_state: faxResult.output_state }, "Fax OCR failed — routed to review");
    }

    // Task #52 — emit ocr.completed for both success and failure so the
    // OCR-routing automation can branch on the `success` flag (low-
    // confidence rows go to a human review queue, clean rows attach to
    // the matched lead). Re-read fax row to surface the resolved lead_id
    // (matcher writes it asynchronously).
    const [finalRow] = await db
      .select()
      .from(faxResultsTable)
      .where(eq(faxResultsTable.id, fax_result_id));
    if (finalRow) {
      dispatchEvent(
        {
          event: "ocr.completed",
          payload: {
            fax_result_id,
            lead_id: finalRow.lead_id,
            drug_name: finalRow.drug_name || null,
            rx_number: finalRow.rx_number || null,
            fill_date: finalRow.fill_date || null,
            quantity: finalRow.quantity || null,
            confidence: finalRow.confidence,
            success: faxResult.success,
            source_file,
          },
        },
        { source: "worker:process_fax" },
      );
    }
  } else if (job.job_type === "send_esign_packet") {
    await handleSendEsignPacket(payload as unknown as Parameters<typeof handleSendEsignPacket>[0]);
  } else if (job.job_type === "fax_med_records_request") {
    await handleFaxMedRecordsRequest(payload as unknown as Parameters<typeof handleFaxMedRecordsRequest>[0]);
  } else if (job.job_type === "send_workflow_email") {
    await handleSendWorkflowEmail(payload as unknown as Parameters<typeof handleSendWorkflowEmail>[0]);
  } else if (job.job_type === "send_workflow_sms") {
    await handleSendWorkflowSms(payload as unknown as Parameters<typeof handleSendWorkflowSms>[0]);
  } else if (job.job_type === "run_bg_check") {
    const { lead_id, source } = payload as { lead_id: number; source?: string };
    const { runBackgroundCheckForLead } = await import("./lib/pipeline/pipeline.js");
    await runBackgroundCheckForLead(lead_id, {
      keySuffix: `job${job.id}`,
      source: source ?? "worker:run_bg_check",
    });
  } else if (job.job_type === "fasten_records_sync") {
    await handleFastenRecordsSync(payload as unknown as Parameters<typeof handleFastenRecordsSync>[0]);
  } else if (job.job_type === "competitive_intel_watchlist_sync") {
    await handleCompetitiveIntelSync(payload as CompetitiveIntelSyncPayload);
  } else if (job.job_type === "dialer_campaign_run") {
    // ── Campaign outbound dialer ──────────────────────────────────────────────
    const { campaign_id } = payload as { campaign_id: unknown };
    if (typeof campaign_id !== "number" || !Number.isInteger(campaign_id) || campaign_id <= 0) {
      throw new NonRetryableJobError(`dialer_campaign_run: campaign_id must be a positive integer, got ${campaign_id}`);
    }

    const [campaign] = await db
      .select()
      .from(dialerCampaignsTable)
      .where(eq(dialerCampaignsTable.id, campaign_id));

    if (!campaign || campaign.status !== "active") {
      logger.info({ campaign_id, status: campaign?.status }, "dialer: campaign not active — stopping worker chain");
      return;
    }

    // ── Call-window guard (timezone-aware) ────────────────────────────────────
    const tz = campaign.timezone ?? "America/New_York";
    const localTime = new Intl.DateTimeFormat("en-US", {
      timeZone: tz, hour: "2-digit", minute: "2-digit", hour12: false,
    }).format(new Date());
    const [lh, lm] = localTime.split(":").map(Number);
    const nowMin = (lh ?? 0) * 60 + (lm ?? 0);
    const [wsh, wsm] = (campaign.call_window_start ?? "09:00").split(":").map(Number);
    const [weh, wem] = (campaign.call_window_end ?? "20:00").split(":").map(Number);
    const windowStart = (wsh ?? 9) * 60 + (wsm ?? 0);
    const windowEnd = (weh ?? 20) * 60 + (wem ?? 0);

    if (nowMin < windowStart || nowMin > windowEnd) {
      // Outside window — re-check in 5 minutes
      await enqueueJob("dialer_campaign_run", { campaign_id }, { delaySeconds: 300 });
      logger.info({ campaign_id, localTime, tz }, "dialer: outside call window — retrying in 5 min");
      return;
    }

    // ── Resolve Vapi credentials ──────────────────────────────────────────────
    const resolved = await resolveProvider("voice");
    if (!isResolved(resolved) || resolved.provider !== "vapi") {
      logger.warn({ campaign_id }, "dialer: Vapi not configured — pausing campaign");
      await db.update(dialerCampaignsTable)
        .set({ status: "paused", updated_at: new Date() })
        .where(eq(dialerCampaignsTable.id, campaign_id));
      return;
    }
    const creds = resolved.credentials as Record<string, unknown>;
    const apiKey = typeof creds.api_key === "string" ? creds.api_key.trim() : "";
    if (!apiKey) {
      logger.warn({ campaign_id }, "dialer: Vapi api_key missing — pausing campaign");
      await db.update(dialerCampaignsTable)
        .set({ status: "paused", updated_at: new Date() })
        .where(eq(dialerCampaignsTable.id, campaign_id));
      return;
    }

    if (!campaign.vapi_assistant_id) {
      logger.warn({ campaign_id }, "dialer: no vapi_assistant_id on campaign — pausing");
      await db.update(dialerCampaignsTable)
        .set({ status: "paused", updated_at: new Date() })
        .where(eq(dialerCampaignsTable.id, campaign_id));
      return;
    }

    // ── Claim next batch of pending leads ─────────────────────────────────────
    const batchSize = Math.max(1, Math.min(campaign.max_concurrent_calls, 10));
    const pendingRows = await db
      .select({
        cl_id: dialerCampaignLeadsTable.id,
        cl_lead_id: dialerCampaignLeadsTable.lead_id,
        cl_attempts: dialerCampaignLeadsTable.attempts,
        phone: leadsTable.phone,
        phone_primary: leadsTable.phone_primary,
        first_name: leadsTable.first_name,
        tort_type: leadsTable.tort_type,
      })
      .from(dialerCampaignLeadsTable)
      .leftJoin(leadsTable, eq(dialerCampaignLeadsTable.lead_id, leadsTable.id))
      .where(
        and(
          eq(dialerCampaignLeadsTable.campaign_id, campaign_id),
          inArray(dialerCampaignLeadsTable.status, ["pending", "queued"]),
        ),
      )
      .orderBy(asc(dialerCampaignLeadsTable.id))
      .limit(batchSize);

    if (pendingRows.length === 0) {
      await db.update(dialerCampaignsTable)
        .set({ status: "completed", updated_at: new Date() })
        .where(eq(dialerCampaignsTable.id, campaign_id));
      logger.info({ campaign_id }, "dialer: campaign completed — all leads dialed");
      return;
    }

    let dialedInBatch = 0;

    for (const row of pendingRows) {
      // `phone` (and the `phone_primary` fallback) are stored encrypted at rest
      // (see ENCRYPTED_FIELDS in lib/encryption). Decrypt before any dialing.
      // decrypt() MUST receive the field name + entity id so its AAD chain can
      // verify (field+id) → (field) → (none); without them only the no-AAD
      // variant is tried and AAD-bound rows fail. It is a no-op on plaintext
      // and returns "[DECRYPTION_ERROR]" on genuine failure. Fall back to
      // phone_primary only AFTER phone fails to decrypt, so a corrupt primary
      // phone doesn't hide a usable secondary number.
      const leadIdStr = String(row.cl_lead_id);
      const decode = (raw: string | null, field: "phone" | "phone_primary") => {
        if (!raw) return null;
        const out = decrypt(raw, field, leadIdStr);
        return out && out !== "[DECRYPTION_ERROR]" ? out : null;
      };
      const phone = decode(row.phone, "phone") ?? decode(row.phone_primary, "phone_primary");

      // No usable phone number (missing, or decryption failed) — skip
      if (!phone || phone === "[DECRYPTION_ERROR]") {
        await db.update(dialerCampaignLeadsTable)
          .set({ status: "failed", disposition: "no_phone", updated_at: new Date() })
          .where(eq(dialerCampaignLeadsTable.id, row.cl_id));
        continue;
      }

      // DNC check
      const normalised = phone.replace(/\D/g, "");
      const [dncHit] = await db
        .select({ id: dialerDncTable.id })
        .from(dialerDncTable)
        .where(
          and(
            eq(dialerDncTable.firm_id, campaign.firm_id),
            or(
              eq(dialerDncTable.phone_number, phone),
              eq(dialerDncTable.phone_number, normalised),
            ),
          ),
        )
        .limit(1);

      if (dncHit) {
        await db.update(dialerCampaignLeadsTable)
          .set({ status: "dnc", disposition: "dnc_blocked", updated_at: new Date() })
          .where(eq(dialerCampaignLeadsTable.id, row.cl_id));
        continue;
      }

      // Mark as dialing
      await db.update(dialerCampaignLeadsTable)
        .set({
          status: "dialing",
          attempts: row.cl_attempts + 1,
          last_called_at: new Date(),
          updated_at: new Date(),
        })
        .where(eq(dialerCampaignLeadsTable.id, row.cl_id));

      // Create call log row
      const [callLog] = await db.insert(callLogsTable).values({
        firm_id: campaign.firm_id,
        lead_id: row.cl_lead_id,
        direction: "outbound",
        to_number: phone,
        from_number: campaign.caller_id,
        vapi_assistant_id: campaign.vapi_assistant_id,
        tort_type: row.tort_type,
        status: "queued",
        transcript: [],
        events: [],
      }).returning();

      // Initiate outbound Vapi call
      try {
        const callPayload: Record<string, unknown> = {
          assistantId: campaign.vapi_assistant_id,
          customer: {
            number: phone,
            ...(row.first_name ? { name: row.first_name } : {}),
          },
          metadata: {
            campaign_id: String(campaign_id),
            campaign_lead_id: String(row.cl_id),
            call_log_id: String(callLog.id),
            firm_id: String(campaign.firm_id),
          },
        };
        if (campaign.vapi_phone_number_id) {
          callPayload.phoneNumberId = campaign.vapi_phone_number_id;
        }

        const resp = await fetch("https://api.vapi.ai/call", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(callPayload),
        });
        const json = await resp.json().catch(() => ({})) as Record<string, unknown>;

        if (resp.ok && json.id) {
          await db.update(callLogsTable)
            .set({ status: "in_progress", vapi_call_id: String(json.id), updated_at: new Date() })
            .where(eq(callLogsTable.id, callLog.id));
          await db.update(dialerCampaignLeadsTable)
            .set({ status: "called", last_call_log_id: callLog.id, updated_at: new Date() })
            .where(eq(dialerCampaignLeadsTable.id, row.cl_id));
          dialedInBatch++;
          logger.info({ campaign_id, lead_id: row.cl_lead_id, vapi_call_id: json.id }, "dialer: outbound call initiated");
        } else {
          const errMsg = typeof json.message === "string" ? json.message : `HTTP ${resp.status}`;
          await db.update(callLogsTable)
            .set({ status: "failed", error: errMsg, updated_at: new Date() })
            .where(eq(callLogsTable.id, callLog.id));
          await db.update(dialerCampaignLeadsTable)
            .set({ status: "failed", disposition: `vapi_error_${resp.status}`, updated_at: new Date() })
            .where(eq(dialerCampaignLeadsTable.id, row.cl_id));
          logger.warn({ campaign_id, lead_id: row.cl_lead_id, status: resp.status, body: json }, "dialer: Vapi call failed");
        }
      } catch (callErr) {
        const errMsg = callErr instanceof Error ? callErr.message : String(callErr);
        await db.update(callLogsTable)
          .set({ status: "failed", error: errMsg, updated_at: new Date() })
          .where(eq(callLogsTable.id, callLog.id));
        await db.update(dialerCampaignLeadsTable)
          .set({ status: "failed", disposition: "network_error", updated_at: new Date() })
          .where(eq(dialerCampaignLeadsTable.id, row.cl_id));
        logger.error({ err: callErr, campaign_id, lead_id: row.cl_lead_id }, "dialer: Vapi call network error");
      }
    }

    // ── Update campaign counters ───────────────────────────────────────────────
    if (dialedInBatch > 0) {
      await db.update(dialerCampaignsTable)
        .set({
          dialed_count: sql`${dialerCampaignsTable.dialed_count} + ${dialedInBatch}`,
          updated_at: new Date(),
        })
        .where(eq(dialerCampaignsTable.id, campaign_id));
    }

    // ── Re-enqueue next batch with mode-appropriate delay ────────────────────
    const delaySeconds = campaign.type === "predictive" ? 3
      : campaign.type === "power" ? 8
      : 15;
    await enqueueJob("dialer_campaign_run", { campaign_id }, { delaySeconds });
    logger.info({ campaign_id, dialedInBatch, delaySeconds }, "dialer: batch done — re-enqueued next tick");
  } else if (job.job_type === "poll_fax_delivery") {
    // ── Poll fax provider for outbound delivery confirmation ──────────────────
    const { fax_result_id, external_fax_id, provider, poll_count } = job.payload as {
      fax_result_id: number;
      external_fax_id: string;
      provider: string;
      integration_id: number | null;
      poll_count: number;
    };

    if (!fax_result_id || !external_fax_id || !provider) {
      throw new NonRetryableJobError(`poll_fax_delivery: missing required fields (fax_result_id=${fax_result_id}, external_fax_id=${external_fax_id}, provider=${provider})`);
    }

    const MAX_FAX_POLLS = 48; // 48 × 5 min = 4 hours max

    // Look up current delivery_status to short-circuit if already terminal.
    const [existing] = await db
      .select({ delivery_status: faxResultsTable.delivery_status })
      .from(faxResultsTable)
      .where(eq(faxResultsTable.id, fax_result_id));

    if (existing?.delivery_status === "delivered" || existing?.delivery_status === "failed") {
      logger.info({ fax_result_id, delivery_status: existing.delivery_status }, "poll_fax_delivery: already terminal — skipping");
    } else if (poll_count >= MAX_FAX_POLLS) {
      await db
        .update(faxResultsTable)
        .set({ delivery_status: "unknown", delivery_checked_at: new Date(), updated_at: new Date() } as any)
        .where(eq(faxResultsTable.id, fax_result_id));
      logger.warn({ fax_result_id, external_fax_id, provider, poll_count }, "poll_fax_delivery: max polls reached — marking unknown");
    } else {
      const adapter = getFaxAdapter(provider);
      if (!adapter || typeof adapter.getStatus !== "function") {
        logger.warn({ provider }, "poll_fax_delivery: adapter missing or no getStatus — skipping");
      } else {
        const resolved = await resolveProvider("fax");
        if (!isResolved(resolved)) {
          logger.warn({ provider }, "poll_fax_delivery: fax provider not resolved in vault — will retry");
          await enqueueJob("poll_fax_delivery", { fax_result_id, external_fax_id, provider, integration_id: null, poll_count: poll_count + 1 }, { delaySeconds: 300 });
        } else {
          const rawStatus = await adapter.getStatus(resolved.credentials, external_fax_id);
          logger.info({ fax_result_id, external_fax_id, provider, rawStatus, poll_count }, "poll_fax_delivery: polled provider");

          // Normalise provider-specific status strings to our enum.
          const DELIVERED = ["y", "delivered", "success", "sent", "ok"];
          const FAILED    = ["n", "failed", "error", "busy", "no_answer", "noanswer", "rejected", "invalid"];
          const lc = String(rawStatus).toLowerCase().trim();
          const deliveryStatus =
            DELIVERED.includes(lc) ? "delivered"
            : FAILED.includes(lc)  ? "failed"
            : "pending";

          await db
            .update(faxResultsTable)
            .set({ delivery_status: deliveryStatus, delivery_checked_at: new Date(), updated_at: new Date() } as any)
            .where(eq(faxResultsTable.id, fax_result_id));

          if (deliveryStatus === "pending") {
            // Not confirmed yet — re-enqueue with 5-minute delay.
            const delaySeconds = poll_count < 12 ? 300 : 1800; // first hour: 5 min; after: 30 min
            await enqueueJob("poll_fax_delivery", { fax_result_id, external_fax_id, provider, integration_id: null, poll_count: poll_count + 1 }, { delaySeconds });
            logger.info({ fax_result_id, poll_count: poll_count + 1, delaySeconds }, "poll_fax_delivery: still pending — re-enqueued");
          } else {
            logger.info({ fax_result_id, deliveryStatus }, "poll_fax_delivery: terminal status reached");
          }
        }
      }
    }
  } else {
    logger.warn({ job_type: job.job_type }, "Unknown job type — skipping");
  }
}

let workerStarted = false;

export async function workerLoop(): Promise<void> {
  if (workerStarted) {
    logger.warn("workerLoop() called more than once in the same process — ignoring duplicate start");
    return;
  }
  workerStarted = true;
  logger.info("MTOS Worker started — polling job queue");

  // Reclaim stale jobs every 60 seconds so a crashed worker can't park
  // jobs in `processing` forever.
  let lastReclaimAt = 0;
  const RECLAIM_EVERY_MS = 60_000;
  const STALE_AFTER_MS = 5 * 60_000;

  // Surface Fasten partial syncs that have sat unresolved for >24h. Hourly
  // tick is plenty — a single audit row per stale partial is the contract,
  // and dedup is enforced via metadata.partial_audited_at inside the helper.
  let lastFastenStaleAuditAt = 0;
  const FASTEN_STALE_AUDIT_EVERY_MS = 60 * 60_000;

  // Auto-refresh all competitive-intel watchlist entries every 6 hours.
  // The job is enqueued (not run inline) so it benefits from the normal
  // job-queue retry / dead-letter policy if the API keys are unavailable.
  let lastCiSyncEnqueuedAt = 0;
  const CI_SYNC_EVERY_MS = 6 * 60 * 60_000;

  while (true) {
    try {
      const now = Date.now();
      if (now - lastReclaimAt > RECLAIM_EVERY_MS) {
        lastReclaimAt = now;
        try {
          await reclaimStaleProcessingJobs(STALE_AFTER_MS);
        } catch (e) {
          logger.error({ err: e }, "Stale-job reclaim failed");
        }
      }
      if (now - lastFastenStaleAuditAt > FASTEN_STALE_AUDIT_EVERY_MS) {
        lastFastenStaleAuditAt = now;
        try {
          await auditStaleFastenPartials();
        } catch (e) {
          logger.error({ err: e }, "Stale Fasten partial audit failed");
        }
      }
      if (now - lastCiSyncEnqueuedAt > CI_SYNC_EVERY_MS) {
        lastCiSyncEnqueuedAt = now;
        try {
          await enqueueJob("competitive_intel_watchlist_sync", { triggered_by: "schedule" });
          logger.info("CI sync job enqueued (scheduled 6h tick)");
        } catch (e) {
          logger.error({ err: e }, "Failed to enqueue competitive_intel_watchlist_sync");
        }
      }
    } catch {
      // never let bookkeeping crash the loop
    }

    try {
      const job = await claimNextJob();
      if (job) {
        try {
          await processJob(job as { id: number; job_type: string; payload: unknown });
          await markJobDone(job.id as number);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          // Poison-pill detection: payloads that violate basic shape contracts
          // (null IDs, malformed UUIDs, missing required fields, raw `null`
          // payload) are dead-lettered immediately so we don't burn 5 retries
          // on a job that can never succeed. Validation errors thrown via
          // `NonRetryableJobError` carry the `nonRetryable: true` marker;
          // everything else is treated as potentially transient.
          const isNonRetryable =
            err !== null &&
            typeof err === "object" &&
            (err as { nonRetryable?: boolean }).nonRetryable === true;
          if (isNonRetryable) {
            logger.error(
              { err, job_id: job.id, job_type: job.job_type },
              "Job rejected as non-retryable poison pill — moving to dead_letter immediately",
            );
            // Structured audit so an admin can see WHY it was rejected without
            // tailing logs. entity_type=job_queue keeps it out of entity-specific
            // audit trails.
            try {
              await auditLog("job_queue", String(job.id), "poison_pill_rejected", {
                job_type: job.job_type,
                error: msg,
                severity: "high",
              });
            } catch (auditErr) {
              logger.error({ err: auditErr, job_id: job.id }, "Failed to audit poison-pill rejection");
            }
            await markJobFailed(job.id as number, msg, { retryable: false });
          } else {
            // Default policy: every other thrown error is *potentially* transient
            // (network blip, vendor 5xx, transient DB error). Workflow handlers
            // explicitly swallow non-retryable provider failures and return
            // normally, so anything that bubbles up here is already screened.
            // MAX_RETRIES + exponential backoff in markJobFailed prevents a
            // poison-pill from looping forever; once retries are exhausted it
            // lands in `dead_letter` for human attention.
            logger.error({ err, job_id: job.id }, "Job processing failed — markJobFailed will retry or dead-letter");
            await markJobFailed(job.id as number, msg, { retryable: true });
          }
        }
      }
    } catch (err) {
      logger.error({ err }, "Worker poll error");
    }

    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
}

// Auto-start when invoked as the standalone worker entry point
// (i.e. `node dist/worker.mjs` via the dev workflow).
// When imported by the API server (index.ts), the caller decides when to start.
const isStandaloneWorker = process.env["MTOS_WORKER_STANDALONE"] === "1"
  || process.argv.some((a) => a.endsWith("worker.mjs") || a.endsWith("worker.ts"));

if (isStandaloneWorker) {
  workerLoop();
}
