/**
 * MTOS Distributed Worker
 * Polls the PostgreSQL job_queue table and processes jobs.
 * Runs as a separate process — started via "pnpm run worker" command.
 */
import { db, casesTable, caseDocumentsTable, analysisTable, faxResultsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { logger } from "./lib/logger";
import { claimNextJob, markJobDone, markJobFailed } from "./lib/queue";
import { saveFile, readFile, listCaseFiles } from "./lib/vault";
import { extractFeatures } from "./lib/ai-extract";
import { scoreFeatures, scoreToVerdict } from "./lib/scoring";
import { auditLog } from "./lib/audit";
import { preprocessFaxBuffer, base64ToBuffer, detectMimeType } from "./lib/ocr-preprocess";
import { extractOcrData } from "./lib/ai-ocr";

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

    for (const doc of docs) {
      let text = "";
      try {
        text = await readFile(doc.path);
      } catch (err) {
        logger.warn({ err, path: doc.path }, "Could not read vault file");
        continue;
      }

      const features = await extractFeatures(text);
      const score = scoreFeatures(features);
      const verdict = scoreToVerdict(score);

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
      });

      logger.info({ case_id, score, verdict }, "Analysis complete");
    }

    await db
      .update(casesTable)
      .set({ status: "analyzed", updated_at: new Date() })
      .where(eq(casesTable.id, case_id));
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
    });

    logger.info(
      { fax_result_id, drug_name: grid.drug_name, confidence: grid.confidence },
      "Fax OCR complete"
    );
  } else {
    logger.warn({ job_type: job.job_type }, "Unknown job type — skipping");
  }
}

async function workerLoop() {
  logger.info("MTOS Worker started — polling job queue");

  while (true) {
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

workerLoop();
