/**
 * MTOS Distributed Worker
 * Polls the PostgreSQL job_queue table and processes jobs.
 * Runs as a separate process — started via "pnpm run worker" command.
 */
import { db, casesTable, caseDocumentsTable, analysisTable, faxResultsTable, reviewQueueTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { logger } from "./lib/logger";
import { claimNextJob, markJobDone, markJobFailed, reclaimStaleProcessingJobs } from "./lib/queue";
import { saveFile, readFile, listCaseFiles } from "./lib/vault";
import { extractFeatures } from "./lib/ai-extract";
import { scoreFeatures, scoreToVerdict } from "./lib/scoring";
import { auditLog } from "./lib/audit";
import { preprocessFaxBuffer, base64ToBuffer, detectMimeType } from "./lib/ocr-preprocess";
import { extractOcrData } from "./lib/ai-ocr";
import { withErrorFallback, createLoopGuard, DEFAULT_LIMITS } from "./lib/error-fallback";
import { handleSendEsignPacket, handleFaxMedRecordsRequest, handleSendWorkflowEmail } from "./lib/workflow-handlers";

const POLL_INTERVAL_MS = 2000;

async function processJob(job: {
  id: number;
  job_type: string;
  payload: unknown;
}) {
  const payload = job.payload as Record<string, unknown>;
  logger.info({ job_id: job.id, job_type: job.job_type }, "Processing job");

  if (job.job_type === "create_case") {
    const { case_id, data } = payload as { case_id: string; data: Record<string, unknown> };
    await db
      .insert(casesTable)
      .values({ id: case_id, data, status: "open" })
      .onConflictDoNothing();
    await auditLog("case", case_id, "created", { data });
    logger.info({ case_id }, "Case created");
  } else if (job.job_type === "ingest_file") {
    const { case_id, file_name, content, content_type } = payload as {
      case_id: string;
      file_name: string;
      content: string;
      content_type?: string;
    };
    const { path, hash, sizeBytes } = await saveFile(case_id, content, file_name);
    await db.insert(caseDocumentsTable).values({
      case_id,
      path,
      file_hash: hash,
      file_name,
      content_type: content_type ?? "text/plain",
    });
    await auditLog("case_document", case_id, "file_ingested", { file_name, hash, sizeBytes });
    logger.info({ case_id, path, sizeBytes }, "File ingested to vault");
  } else if (job.job_type === "analyze_case") {
    const { case_id } = payload as { case_id: string };

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
    await db
      .update(casesTable)
      .set({ status: finalStatus, updated_at: new Date() })
      .where(eq(casesTable.id, case_id));

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

        const processedBuffer = await preprocessFaxBuffer(rawBuffer);
        const processedBase64 = processedBuffer.toString("base64");

        const grid = await extractOcrData(processedBase64, detectedMime);

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
  } else if (job.job_type === "send_esign_packet") {
    await handleSendEsignPacket(payload as unknown as Parameters<typeof handleSendEsignPacket>[0]);
  } else if (job.job_type === "fax_med_records_request") {
    await handleFaxMedRecordsRequest(payload as unknown as Parameters<typeof handleFaxMedRecordsRequest>[0]);
  } else if (job.job_type === "send_workflow_email") {
    await handleSendWorkflowEmail(payload as unknown as Parameters<typeof handleSendWorkflowEmail>[0]);
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
          logger.error({ err, job_id: job.id }, "Job processing failed");
          await markJobFailed(job.id as number, msg);
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
