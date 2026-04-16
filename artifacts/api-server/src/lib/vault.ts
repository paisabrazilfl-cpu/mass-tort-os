import fs from "fs/promises";
import path from "path";
import crypto from "crypto";

const VAULT_BASE = path.resolve(process.cwd(), "vault");

function sanitizeCaseId(caseId: string): string {
  const sanitized = caseId.replace(/[^a-zA-Z0-9_-]/g, "_");
  if (!sanitized || sanitized === "." || sanitized === "..") {
    throw new Error("Invalid case ID");
  }
  return sanitized;
}

function assertWithinVault(targetPath: string): void {
  const resolved = path.resolve(targetPath);
  if (!resolved.startsWith(VAULT_BASE + path.sep) && resolved !== VAULT_BASE) {
    throw new Error("Path traversal detected — access denied");
  }
}

export async function ensureVaultDir(caseId: string): Promise<string> {
  const safeCaseId = sanitizeCaseId(caseId);
  const dir = path.join(VAULT_BASE, safeCaseId);
  assertWithinVault(dir);
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

export async function saveFile(
  caseId: string,
  content: Buffer | string,
  fileName: string
): Promise<{ path: string; hash: string; sizeBytes: number }> {
  const dir = await ensureVaultDir(caseId);
  const timestamp = Date.now();
  const sanitizedName = fileName.replace(/[^a-zA-Z0-9._-]/g, "_");
  const filePath = path.join(dir, `${timestamp}_${sanitizedName}`);
  assertWithinVault(filePath);

  const buffer = typeof content === "string" ? Buffer.from(content, "utf-8") : content;
  await fs.writeFile(filePath, buffer);

  const hash = crypto.createHash("sha256").update(buffer).digest("hex");
  return { path: filePath, hash, sizeBytes: buffer.length };
}

export async function readFile(filePath: string): Promise<string> {
  const resolved = path.resolve(filePath);
  assertWithinVault(resolved);
  const stat = await fs.lstat(resolved);
  if (stat.isSymbolicLink()) {
    throw new Error("Symlink access denied in vault");
  }
  return fs.readFile(resolved, "utf-8");
}

export async function listCaseFiles(caseId: string): Promise<string[]> {
  const safeCaseId = sanitizeCaseId(caseId);
  const dir = path.join(VAULT_BASE, safeCaseId);
  assertWithinVault(dir);
  try {
    const files = await fs.readdir(dir);
    return files.map((f) => path.join(dir, f));
  } catch {
    return [];
  }
}
