/**
 * MTOS OCR API — Fax Inbox → Legora Grid
 * Accepts fax images, enqueues processing, returns structured Rx data.
 */
import { Router } from "express";
import { db, faxResultsTable, jobQueueTable } from "@workspace/db";
import { eq, desc } from "drizzle-orm";
import { logger } from "../lib/logger";
import { saveFile } from "../lib/vault";
import { auditLog } from "../lib/audit";
import { extractMedicalFields, analyzeDocumentText } from "../lib/ai-fields";
import { requireRole, auditAction } from "../lib/rbac";
import { badRequest, notFound, serverError } from "../lib/http-errors";

const router = Router();

/**
 * POST /api/ocr/upload
 * Upload a fax image (base64-encoded) → enqueues process_fax job
 * Body: { file_name: string, image_base64: string, mime_type?: string }
 */
router.post("/upload", requireRole("paralegal", "attorney", "admin"), auditAction("ocr_upload"), async (req, res) => {
  const { file_name, image_base64, mime_type } = req.body as {
    file_name: string;
    image_base64: string;
    mime_type?: string;
  };

  if (!file_name || !image_base64) {
    badRequest(res, "file_name and image_base64 are required");
    return;
  }

  const faxInboxId = `fax_${Date.now()}`;

  const { path } = await saveFile(
    faxInboxId,
    image_base64,
    file_name
  );

  const [result] = await db
    .insert(faxResultsTable)
    .values({
      source_file: file_name,
      vault_path: path,
      status: "pending",
    })
    .returning();

  const [job] = await db
    .insert(jobQueueTable)
    .values({
      job_type: "process_fax",
      payload: {
        fax_result_id: result.id,
        vault_path: path,
        source_file: file_name,
        mime_type: mime_type ?? "image/png",
      },
    })
    .returning({ id: jobQueueTable.id });

  await db
    .update(faxResultsTable)
    .set({ job_id: job.id })
    .where(eq(faxResultsTable.id, result.id));

  await auditLog("fax", String(result.id), "uploaded", { file_name, path });

  logger.info({ fax_result_id: result.id, job_id: job.id }, "Fax uploaded, processing queued");

  res.status(200).json({
    fax_result_id: result.id,
    status: "queued",
    job_id: job.id,
    vault_path: path,
  });
});

/**
 * GET /api/ocr/results
 * List all Legora Grid results
 */
router.get("/results", requireRole("paralegal"), async (_req, res) => {
  const results = await db
    .select()
    .from(faxResultsTable)
    .orderBy(desc(faxResultsTable.created_at));

  res.json(results);
});

/**
 * GET /api/ocr/results/:id
 * Get a single Legora Grid result
 */
router.get("/results/:id", requireRole("paralegal"), async (req, res) => {
  const id = parseInt(String(req.params.id), 10);
  if (isNaN(id)) {
    badRequest(res, "Invalid ID");
    return;
  }

  const [result] = await db
    .select()
    .from(faxResultsTable)
    .where(eq(faxResultsTable.id, id));

  if (!result) {
    notFound(res, "Not found");
    return;
  }

  res.json(result);
});

/**
 * GET /api/ocr/queue-stats
 * OCR queue stats
 */
router.get("/queue-stats", requireRole("admin"), async (_req, res) => {
  const results = await db.select().from(faxResultsTable);
  const stats: Record<string, number> = {};
  for (const r of results) {
    stats[r.status] = (stats[r.status] ?? 0) + 1;
  }
  res.json(stats);
});

router.post("/ai-fields", requireRole("paralegal", "attorney", "admin"), auditAction("ai_fields_extract"), async (req, res) => {
  const { image_base64, mime_type, text } = req.body;

  if (!image_base64 && !text) {
    badRequest(res, "image_base64 or text is required");
    return;
  }

  try {
    let result;
    if (image_base64) {
      result = await extractMedicalFields(image_base64, mime_type || "image/png");
    } else {
      result = await analyzeDocumentText(text);
    }
    res.json(result);
  } catch (err) {
    logger.error({ err }, "AIFields extraction failed");
    serverError(res, "AIFields extraction failed");
  }
});

router.post("/ai-fields/result/:id", requireRole("paralegal", "attorney", "admin"), async (req, res) => {
  const id = parseInt(String(req.params.id), 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid ID" }); return; }

  const [faxResult] = await db.select().from(faxResultsTable).where(eq(faxResultsTable.id, id));
  if (!faxResult) { res.status(404).json({ error: "Fax result not found" }); return; }

  if (!faxResult.raw_text) { res.status(400).json({ error: "No text available for analysis" }); return; }

  try {
    const fields = await analyzeDocumentText(faxResult.raw_text);
    res.json({ fax_result_id: id, ...fields });
  } catch (err) {
    logger.error({ err }, "AIFields analysis of fax result failed");
    serverError(res, "Analysis failed");
  }
});

export default router;
