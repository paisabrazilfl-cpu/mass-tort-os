import crypto from "crypto";
import { db, templateFilesTable } from "@workspace/db";
import { eq } from "drizzle-orm";

/**
 * Postgres-backed template storage.
 *
 * Production runs on autoscale, where local disk is ephemeral and not shared
 * across replicas. Storing template PDFs as bytea in Postgres makes uploads
 * durable and visible to every API + worker process.
 *
 * The returned `storagePath` (a stable storage_key like "tpl:<ts>_<rand>_<name>")
 * is persisted in document_templates.storage_path; downloads/deletes look it up
 * directly in template_files.
 */

function sanitizeFileName(name: string): string {
  const cleaned = name.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 200);
  return cleaned || "template.pdf";
}

function buildStorageKey(safeName: string): string {
  const ts = Date.now();
  const random = crypto.randomBytes(4).toString("hex");
  return `tpl:${ts}_${random}_${safeName}`;
}

export interface StoredTemplate {
  storagePath: string;
  hash: string;
  sizeBytes: number;
}

export const MAX_TEMPLATE_BYTES = 10 * 1024 * 1024; // 10 MB

export async function uploadTemplate(
  content: Buffer,
  fileName: string,
  contentType: string = "application/pdf",
): Promise<StoredTemplate> {
  if (!Buffer.isBuffer(content) || content.length === 0) {
    throw new Error("Template content is empty");
  }
  if (content.length > MAX_TEMPLATE_BYTES) {
    throw new Error(
      `Template too large: ${content.length} bytes (max ${MAX_TEMPLATE_BYTES})`,
    );
  }
  const safeName = sanitizeFileName(fileName);
  const storageKey = buildStorageKey(safeName);
  const hash = crypto.createHash("sha256").update(content).digest("hex");
  const sizeBytes = content.length;

  await db.insert(templateFilesTable).values({
    storage_key: storageKey,
    file_name: safeName,
    content_type: contentType,
    content,
    hash,
    size_bytes: sizeBytes,
  });

  return { storagePath: storageKey, hash, sizeBytes };
}

export async function downloadTemplate(storagePath: string): Promise<Buffer> {
  if (!storagePath) {
    throw new Error("storagePath is required");
  }
  // Templates uploaded before the Postgres-backed storage migration used
  // local filesystem paths. Those files are gone in autoscale; surface a
  // clear error so callers (and admins) can re-upload instead of getting
  // a confusing "not found".
  if (!storagePath.startsWith("tpl:")) {
    throw new Error(
      `Legacy disk-based template path detected ("${storagePath}"). Please re-upload this template — files on local disk do not persist in the deployed environment.`,
    );
  }
  const rows = await db
    .select({ content: templateFilesTable.content })
    .from(templateFilesTable)
    .where(eq(templateFilesTable.storage_key, storagePath))
    .limit(1);
  if (rows.length === 0) {
    throw new Error(`Template not found: ${storagePath}`);
  }
  const buf = rows[0]!.content;
  return Buffer.isBuffer(buf) ? buf : Buffer.from(buf as unknown as Uint8Array);
}

export async function deleteTemplate(storagePath: string): Promise<void> {
  if (!storagePath) return;
  await db
    .delete(templateFilesTable)
    .where(eq(templateFilesTable.storage_key, storagePath));
}

export async function templateExists(storagePath: string): Promise<boolean> {
  if (!storagePath) return false;
  const rows = await db
    .select({ id: templateFilesTable.id })
    .from(templateFilesTable)
    .where(eq(templateFilesTable.storage_key, storagePath))
    .limit(1);
  return rows.length > 0;
}
