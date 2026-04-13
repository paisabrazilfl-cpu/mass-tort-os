import fs from "fs/promises";
import path from "path";
import crypto from "crypto";

const VAULT_BASE = path.resolve(process.cwd(), "vault");

export async function ensureVaultDir(caseId: string): Promise<string> {
  const dir = path.join(VAULT_BASE, caseId);
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

  const buffer = typeof content === "string" ? Buffer.from(content, "utf-8") : content;
  await fs.writeFile(filePath, buffer);

  const hash = crypto.createHash("sha256").update(buffer).digest("hex");
  return { path: filePath, hash, sizeBytes: buffer.length };
}

export async function readFile(filePath: string): Promise<string> {
  return fs.readFile(filePath, "utf-8");
}

export async function listCaseFiles(caseId: string): Promise<string[]> {
  const dir = path.join(VAULT_BASE, caseId);
  try {
    const files = await fs.readdir(dir);
    return files.map((f) => path.join(dir, f));
  } catch {
    return [];
  }
}
