import fs from "fs/promises";
import path from "path";
import crypto from "crypto";

const TEMPLATES_BASE = path.resolve(process.cwd(), "vault", "templates");

function assertWithinBase(targetPath: string): void {
  const resolved = path.resolve(targetPath);
  if (!resolved.startsWith(TEMPLATES_BASE + path.sep) && resolved !== TEMPLATES_BASE) {
    throw new Error("Path traversal detected — template storage access denied");
  }
}

async function ensureBase(): Promise<void> {
  await fs.mkdir(TEMPLATES_BASE, { recursive: true });
}

function sanitizeFileName(name: string): string {
  const cleaned = name.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 200);
  return cleaned || "template.pdf";
}

export interface StoredTemplate {
  storagePath: string;
  hash: string;
  sizeBytes: number;
}

/**
 * Save a template PDF to local storage. Returns a stable storage_path
 * suitable for persistence in document_templates.storage_path.
 */
export async function uploadTemplate(
  content: Buffer,
  fileName: string,
): Promise<StoredTemplate> {
  await ensureBase();
  const safeName = sanitizeFileName(fileName);
  const timestamp = Date.now();
  const random = crypto.randomBytes(4).toString("hex");
  const filePath = path.join(TEMPLATES_BASE, `${timestamp}_${random}_${safeName}`);
  assertWithinBase(filePath);
  await fs.writeFile(filePath, content);
  const hash = crypto.createHash("sha256").update(content).digest("hex");
  return { storagePath: filePath, hash, sizeBytes: content.length };
}

/**
 * Read a template by its stored path. Always validates the path is within
 * the template vault — no traversal, no symlinks.
 */
export async function downloadTemplate(storagePath: string): Promise<Buffer> {
  const resolved = path.resolve(storagePath);
  assertWithinBase(resolved);
  const stat = await fs.lstat(resolved);
  if (stat.isSymbolicLink()) {
    throw new Error("Symlink access denied in template vault");
  }
  return fs.readFile(resolved);
}

export async function deleteTemplate(storagePath: string): Promise<void> {
  const resolved = path.resolve(storagePath);
  assertWithinBase(resolved);
  try {
    await fs.unlink(resolved);
  } catch {
    // Already gone — idempotent.
  }
}

export async function templateExists(storagePath: string): Promise<boolean> {
  try {
    const resolved = path.resolve(storagePath);
    assertWithinBase(resolved);
    await fs.access(resolved);
    return true;
  } catch {
    return false;
  }
}
