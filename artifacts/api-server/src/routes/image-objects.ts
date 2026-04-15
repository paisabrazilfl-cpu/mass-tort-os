import { Router } from "express";
import crypto from "crypto";
import { db, imageObjectsTable } from "@workspace/db";
import { eq, desc, and, sql } from "drizzle-orm";
import { requireRole } from "../lib/rbac";
import { auditLog } from "../lib/audit";
import { logger } from "../lib/logger";

const router = Router();

function sanitizeForClient(image: any) {
  const { vault_path, ...safe } = image;
  return safe;
}

router.get("/", requireRole("paralegal"), async (req, res) => {
  try {
    const { source_type, lead_id, case_id, limit = "50", offset = "0" } = req.query;

    const conditions: any[] = [];
    if (source_type) conditions.push(eq(imageObjectsTable.source_type, String(source_type)));
    if (lead_id) conditions.push(eq(imageObjectsTable.lead_id, Number(lead_id)));
    if (case_id) conditions.push(eq(imageObjectsTable.case_id, String(case_id)));

    const results = await db
      .select()
      .from(imageObjectsTable)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(desc(imageObjectsTable.created_at))
      .limit(Number(limit))
      .offset(Number(offset));

    res.json(results.map(sanitizeForClient));
  } catch (err) {
    logger.error({ err }, "Failed to list image objects");
    res.status(500).json({ error: "Failed to list image objects" });
  }
});

router.get("/stats", requireRole("paralegal"), async (_req, res) => {
  try {
    const totalResult = await db.execute(sql`SELECT count(*)::int as total FROM image_objects`);
    const bySource = await db.execute(sql`SELECT source_type, count(*)::int as count FROM image_objects GROUP BY source_type`);
    const byOcr = await db.execute(sql`SELECT ocr_status, count(*)::int as count FROM image_objects GROUP BY ocr_status`);
    const totalSize = await db.execute(sql`SELECT coalesce(sum(file_size), 0)::bigint as total FROM image_objects`);
    const sensitiveCount = await db.execute(sql`SELECT count(*)::int as count FROM image_objects WHERE is_sensitive = true`);

    res.json({
      total: Number(totalResult.rows[0]?.total || 0),
      total_size_bytes: Number(totalSize.rows[0]?.total || 0),
      sensitive_count: Number(sensitiveCount.rows[0]?.count || 0),
      by_source: Object.fromEntries((bySource.rows || []).map((r: any) => [r.source_type, r.count])),
      by_ocr_status: Object.fromEntries((byOcr.rows || []).map((r: any) => [r.ocr_status, r.count])),
    });
  } catch (err) {
    logger.error({ err }, "Failed to get image stats");
    res.status(500).json({ error: "Failed to get image stats" });
  }
});

router.get("/:id", requireRole("paralegal"), async (req, res) => {
  try {
    const [image] = await db
      .select()
      .from(imageObjectsTable)
      .where(eq(imageObjectsTable.id, Number(req.params.id)));

    if (!image) return res.status(404).json({ error: "Image object not found" });
    res.json(sanitizeForClient(image));
  } catch (err) {
    logger.error({ err }, "Failed to get image object");
    res.status(500).json({ error: "Failed to get image object" });
  }
});

router.post("/", requireRole("paralegal"), async (req, res) => {
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
      return res.status(400).json({ error: "file_data, original_filename, and mime_type are required" });
    }

    const allowedMimes = ["image/jpeg", "image/png", "image/gif", "image/webp", "image/tiff", "application/pdf"];
    if (!allowedMimes.includes(mime_type)) {
      return res.status(400).json({ error: `Unsupported mime type: ${mime_type}. Allowed: ${allowedMimes.join(", ")}` });
    }

    const buffer = Buffer.from(file_data, "base64");

    const maxSize = 50 * 1024 * 1024;
    if (buffer.length > maxSize) {
      return res.status(400).json({ error: `File exceeds maximum size of ${maxSize / 1024 / 1024}MB` });
    }

    const checksum = crypto.createHash("sha256").update(buffer).digest("hex");

    const [existing] = await db
      .select()
      .from(imageObjectsTable)
      .where(eq(imageObjectsTable.checksum_sha256, checksum));

    if (existing) {
      return res.status(409).json({
        error: "Duplicate image detected",
        existing_id: existing.id,
        checksum,
      });
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
    res.status(500).json({ error: "Failed to create image object" });
  }
});

router.patch("/:id", requireRole("paralegal"), async (req, res) => {
  try {
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

    const [updated] = await db
      .update(imageObjectsTable)
      .set(updates)
      .where(eq(imageObjectsTable.id, Number(req.params.id)))
      .returning();

    if (!updated) return res.status(404).json({ error: "Image object not found" });

    await auditLog("image_object", String(updated.id), "image_object_updated", {
      fields_updated: Object.keys(updates).filter(k => k !== "updated_at"),
      user_email: req.user?.email,
    });

    res.json(sanitizeForClient(updated));
  } catch (err) {
    logger.error({ err }, "Failed to update image object");
    res.status(500).json({ error: "Failed to update image object" });
  }
});

router.delete("/:id", requireRole("admin"), async (req, res) => {
  try {
    const [image] = await db
      .select()
      .from(imageObjectsTable)
      .where(eq(imageObjectsTable.id, Number(req.params.id)));

    if (!image) return res.status(404).json({ error: "Image object not found" });

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
    res.status(500).json({ error: "Failed to delete image object" });
  }
});

router.get("/:id/integrity", requireRole("paralegal"), async (req, res) => {
  try {
    const [image] = await db
      .select()
      .from(imageObjectsTable)
      .where(eq(imageObjectsTable.id, Number(req.params.id)));

    if (!image) return res.status(404).json({ error: "Image object not found" });

    const fs = await import("fs");
    if (!fs.existsSync(image.vault_path)) {
      return res.json({ valid: false, reason: "File missing from vault", image_id: image.id });
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
    res.status(500).json({ error: "Integrity check failed" });
  }
});

export default router;
