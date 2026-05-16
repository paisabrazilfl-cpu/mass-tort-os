import { Router } from "express";
import crypto from "crypto";
import { db, imageObjectsTable, leadsTable, casesTable } from "@workspace/db";
import { eq, desc, and, or, sql } from "drizzle-orm";
import { Permission, requirePermission } from "../lib/rbac";
import { auditLog } from "../lib/audit";
import { logger } from "../lib/logger";
import { badRequest, notFound, serverError } from "../lib/http-errors";
import { requireFirmId } from "../lib/firm-scope";

const router = Router();

const MAX_LIST_LIMIT = 200;

function sanitizeForClient(image: any) {
  const { vault_path, ...safe } = image;
  return safe;
}

// Returns positive integer or null. Invalid (non-numeric / <=0 / non-integer)
// returns undefined so callers can distinguish "not provided" from "garbage".
function parsePositiveIntOrInvalid(value: unknown): number | null | undefined {
  if (value === undefined || value === null || value === "") return null;
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) return undefined;
  return n;
}

function parseIdParam(res: any, raw: unknown, label = "id"): number | null {
  const n = Number(Array.isArray(raw) ? raw[0] : raw);
  if (!Number.isInteger(n) || n <= 0) {
    badRequest(res, `${label} must be a positive integer`);
    return null;
  }
  return n;
}

// Firm-scope predicate for image_objects. The table itself has no firm_id —
// scope is inherited from the parent lead_id or case_id. An image is visible
// to a caller iff at least one of:
//   • its lead_id points at a lead in the caller's firm, OR
//   • its case_id points at a case in the caller's firm.
// Images attached to neither are intentionally invisible to listing (they
// are typically transient OCR scratch files and have no tenant owner).
function firmScopedImagePredicate(firmId: number) {
  const leadScoped = sql`${imageObjectsTable.lead_id} IN (SELECT id FROM ${leadsTable} WHERE ${leadsTable.firm_id} = ${firmId})`;
  const caseScoped = sql`${imageObjectsTable.case_id} IN (SELECT id FROM ${casesTable} WHERE ${casesTable.firm_id} = ${firmId})`;
  return or(leadScoped, caseScoped)!;
}

router.get("/", requirePermission(Permission.IMAGE_OBJECTS_VIEW), async (req, res) => {
  try {
    const firmId = requireFirmId(req);
    const { source_type, lead_id, case_id, limit = "50", offset = "0" } = req.query;

    const conditions: any[] = [firmScopedImagePredicate(firmId)];
    if (source_type) conditions.push(eq(imageObjectsTable.source_type, String(source_type)));
    if (lead_id !== undefined && lead_id !== "") {
      const parsed = parsePositiveIntOrInvalid(lead_id);
      if (parsed === undefined) { badRequest(res, "lead_id must be a positive integer"); return; }
      if (parsed !== null) conditions.push(eq(imageObjectsTable.lead_id, parsed));
    }
    if (case_id) conditions.push(eq(imageObjectsTable.case_id, String(case_id)));

    const limitNum = Math.min(Math.max(Number(limit) || 50, 1), MAX_LIST_LIMIT);
    const offsetNum = Math.max(Number(offset) || 0, 0);

    const results = await db
      .select()
      .from(imageObjectsTable)
      .where(and(...conditions))
      .orderBy(desc(imageObjectsTable.created_at))
      .limit(limitNum)
      .offset(offsetNum);

    res.json(results.map(sanitizeForClient));
  } catch (err) {
    logger.error({ err }, "Failed to list image objects");
    serverError(res, "Failed to list image objects");
  }
});

router.get("/stats", requirePermission(Permission.IMAGE_OBJECTS_VIEW), async (req, res) => {
  try {
    const firmId = requireFirmId(req);
    // All aggregates must restrict to images attached to this firm's leads
    // or cases. Without the EXISTS gate /stats returned global counts and
    // total bytes, leaking the platform's overall scale across tenants.
    const totalResult = await db.execute(sql`
      SELECT count(*)::int AS total FROM image_objects io
      WHERE io.lead_id IN (SELECT id FROM leads WHERE firm_id = ${firmId})
         OR io.case_id IN (SELECT id FROM cases WHERE firm_id = ${firmId})
    `);
    const bySource = await db.execute(sql`
      SELECT source_type, count(*)::int AS count FROM image_objects io
      WHERE io.lead_id IN (SELECT id FROM leads WHERE firm_id = ${firmId})
         OR io.case_id IN (SELECT id FROM cases WHERE firm_id = ${firmId})
      GROUP BY source_type
    `);
    const byOcr = await db.execute(sql`
      SELECT ocr_status, count(*)::int AS count FROM image_objects io
      WHERE io.lead_id IN (SELECT id FROM leads WHERE firm_id = ${firmId})
         OR io.case_id IN (SELECT id FROM cases WHERE firm_id = ${firmId})
      GROUP BY ocr_status
    `);
    const totalSize = await db.execute(sql`
      SELECT coalesce(sum(file_size), 0)::bigint AS total FROM image_objects io
      WHERE io.lead_id IN (SELECT id FROM leads WHERE firm_id = ${firmId})
         OR io.case_id IN (SELECT id FROM cases WHERE firm_id = ${firmId})
    `);
    const sensitiveCount = await db.execute(sql`
      SELECT count(*)::int AS count FROM image_objects io
      WHERE io.is_sensitive = true
        AND (io.lead_id IN (SELECT id FROM leads WHERE firm_id = ${firmId})
          OR io.case_id IN (SELECT id FROM cases WHERE firm_id = ${firmId}))
    `);

    res.json({
      total: Number(totalResult.rows[0]?.total || 0),
      total_size_bytes: Number(totalSize.rows[0]?.total || 0),
      sensitive_count: Number(sensitiveCount.rows[0]?.count || 0),
      by_source: Object.fromEntries((bySource.rows || []).map((r: any) => [r.source_type, r.count])),
      by_ocr_status: Object.fromEntries((byOcr.rows || []).map((r: any) => [r.ocr_status, r.count])),
    });
  } catch (err) {
    logger.error({ err }, "Failed to get image stats");
    serverError(res, "Failed to get image stats");
  }
});

router.get("/:id", requirePermission(Permission.IMAGE_OBJECTS_VIEW), async (req, res) => {
  try {
    const id = parseIdParam(res, req.params.id);
    if (id === null) return;
    const firmId = requireFirmId(req);
    const [image] = await db
      .select()
      .from(imageObjectsTable)
      .where(and(eq(imageObjectsTable.id, id), firmScopedImagePredicate(firmId)));

    if (!image) { notFound(res, "Image object not found"); return; }
    res.json(sanitizeForClient(image));
  } catch (err) {
    logger.error({ err }, "Failed to get image object");
    serverError(res, "Failed to get image object");
  }
});

router.post("/", requirePermission(Permission.IMAGE_OBJECTS_MANAGE), async (req, res) => {
  try {
    const {
      file_data,
      original_filename,
      mime_type,
      source_type = "upload",
      lead_id,
      document_id,
      fax_result_id,
      case_id,
      is_sensitive = true,
      access_classification = "confidential",
      metadata,
    } = req.body;

    if (!file_data || !original_filename || !mime_type) {
      res.status(400).json({ error: "file_data, original_filename, and mime_type are required" }); return;
    }

    // Validate that any parent lead/case provided belongs to the caller's
    // firm BEFORE writing the row. Otherwise an operator could create an
    // image_objects row pointing at another firm's lead_id/case_id and
    // resurface it later. We require at least ONE attachment so list/get
    // never silently hides the row; pure-anon uploads (lead_id=null AND
    // case_id=null) would be invisible to the firm-scoped list endpoint.
    const firmId = requireFirmId(req);
    if (lead_id != null) {
      const lid = Number(lead_id);
      if (!Number.isInteger(lid) || lid <= 0) { badRequest(res, "lead_id must be a positive integer"); return; }
      const [lead] = await db.select({ id: leadsTable.id }).from(leadsTable)
        .where(and(eq(leadsTable.id, lid), eq(leadsTable.firm_id, firmId))).limit(1);
      if (!lead) { notFound(res, "Lead not found in your firm"); return; }
    }
    if (case_id != null) {
      const [cse] = await db.select({ id: casesTable.id }).from(casesTable)
        .where(and(eq(casesTable.id, String(case_id)), eq(casesTable.firm_id, firmId))).limit(1);
      if (!cse) { notFound(res, "Case not found in your firm"); return; }
    }
    if (lead_id == null && case_id == null) {
      badRequest(res, "image must be attached to a lead_id or case_id in your firm");
      return;
    }

    const allowedMimes = ["image/jpeg", "image/png", "image/gif", "image/webp", "image/tiff", "application/pdf"];
    if (!allowedMimes.includes(mime_type)) {
      res.status(400).json({ error: `Unsupported mime type: ${mime_type}. Allowed: ${allowedMimes.join(", ")}` }); return;
    }

    const buffer = Buffer.from(file_data, "base64");

    const maxSize = 50 * 1024 * 1024;
    if (buffer.length > maxSize) {
      res.status(400).json({ error: `File exceeds maximum size of ${maxSize / 1024 / 1024}MB` }); return;
    }

    const checksum = crypto.createHash("sha256").update(buffer).digest("hex");

    const [existing] = await db
      .select()
      .from(imageObjectsTable)
      .where(eq(imageObjectsTable.checksum_sha256, checksum));

    if (existing) {
      res.status(409).json({
        error: "Duplicate image detected",
        existing_id: existing.id,
        checksum,
      }); return;
    }

    let width: number | null = null;
    let height: number | null = null;
    try {
      const sharp = (await import("sharp")).default;
      const meta = await sharp(buffer).metadata();
      width = meta.width || null;
      height = meta.height || null;
    } catch {
    }

    const fs = await import("fs");
    const path = await import("path");
    const vaultDir = path.join(process.cwd(), "vault", "images");
    fs.mkdirSync(vaultDir, { recursive: true });
    const safeFilename = `${Date.now()}_${checksum.slice(0, 12)}_${original_filename.replace(/[^a-zA-Z0-9._-]/g, "_")}`;
    const vaultPath = path.join(vaultDir, safeFilename);
    fs.writeFileSync(vaultPath, buffer);

    const user = req.user;
    const [image] = await db
      .insert(imageObjectsTable)
      .values({
        original_filename,
        mime_type,
        file_size: buffer.length,
        width,
        height,
        source_type,
        vault_path: vaultPath,
        checksum_sha256: checksum,
        ocr_status: "pending",
        lead_id: lead_id || null,
        document_id: document_id || null,
        fax_result_id: fax_result_id || null,
        case_id: case_id || null,
        is_sensitive,
        access_classification,
        metadata: metadata || null,
        created_by: user?.email || "system",
      })
      .returning();

    await auditLog("image_object", String(image.id), "image_object_created", {
      filename: original_filename,
      checksum,
      source_type,
      file_size: buffer.length,
      user_email: user?.email,
    });

    logger.info({ image_id: image.id, checksum, source_type }, "Image object created");
    res.status(201).json(sanitizeForClient(image));
  } catch (err) {
    logger.error({ err }, "Failed to create image object");
    serverError(res, "Failed to create image object");
  }
});

router.patch("/:id", requirePermission(Permission.IMAGE_OBJECTS_MANAGE), async (req, res) => {
  try {
    const id = parseIdParam(res, req.params.id);
    if (id === null) return;
    const allowedFields = [
      "ocr_status", "ocr_text", "ocr_confidence", "ocr_extracted_fields",
      "lead_id", "document_id", "fax_result_id", "case_id",
      "is_sensitive", "access_classification", "retention_days", "metadata",
    ];

    const updates: Record<string, any> = { updated_at: new Date() };
    for (const field of allowedFields) {
      if (req.body[field] !== undefined) {
        updates[field] = req.body[field];
      }
    }

    const firmId = requireFirmId(req);
    const [updated] = await db
      .update(imageObjectsTable)
      .set(updates)
      .where(and(eq(imageObjectsTable.id, id), firmScopedImagePredicate(firmId)))
      .returning();

    if (!updated) { notFound(res, "Image object not found"); return; }

    await auditLog("image_object", String(updated.id), "image_object_updated", {
      fields_updated: Object.keys(updates).filter(k => k !== "updated_at"),
      user_email: req.user?.email,
    });

    res.json(sanitizeForClient(updated));
  } catch (err) {
    logger.error({ err }, "Failed to update image object");
    serverError(res, "Failed to update image object");
  }
});

router.delete("/:id", requirePermission(Permission.IMAGE_OBJECTS_DELETE), async (req, res) => {
  try {
    const id = parseIdParam(res, req.params.id);
    if (id === null) return;
    const firmId = requireFirmId(req);
    const [image] = await db
      .select()
      .from(imageObjectsTable)
      .where(and(eq(imageObjectsTable.id, id), firmScopedImagePredicate(firmId)));

    if (!image) { notFound(res, "Image object not found"); return; }

    try {
      const fs = await import("fs");
      if (fs.existsSync(image.vault_path)) {
        fs.unlinkSync(image.vault_path);
      }
    } catch (fsErr) {
      logger.warn({ err: fsErr }, "Failed to delete vault file");
    }

    await db.delete(imageObjectsTable).where(eq(imageObjectsTable.id, image.id));

    await auditLog("image_object", String(image.id), "image_object_deleted", {
      filename: image.original_filename,
      checksum: image.checksum_sha256,
      user_email: req.user?.email,
    });

    res.json({ success: true, deleted_id: image.id });
  } catch (err) {
    logger.error({ err }, "Failed to delete image object");
    serverError(res, "Failed to delete image object");
  }
});

router.get("/:id/integrity", requirePermission(Permission.IMAGE_OBJECTS_VIEW), async (req, res) => {
  try {
    const id = parseIdParam(res, req.params.id);
    if (id === null) return;
    const [image] = await db
      .select()
      .from(imageObjectsTable)
      .where(eq(imageObjectsTable.id, id));

    if (!image) { res.status(404).json({ error: "Image object not found" }); return; }

    const fs = await import("fs");
    if (!fs.existsSync(image.vault_path)) {
      res.json({ valid: false, reason: "File missing from vault", image_id: image.id }); return;
    }

    const buffer = fs.readFileSync(image.vault_path);
    const currentChecksum = crypto.createHash("sha256").update(buffer).digest("hex");
    const valid = currentChecksum === image.checksum_sha256;

    res.json({
      valid,
      image_id: image.id,
      stored_checksum: image.checksum_sha256,
      current_checksum: currentChecksum,
      file_size_match: buffer.length === image.file_size,
      reason: valid ? "Integrity verified" : "Checksum mismatch — file may be tampered",
    });
  } catch (err) {
    logger.error({ err }, "Integrity check failed");
    serverError(res, "Integrity check failed");
  }
});

export default router;
