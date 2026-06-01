// Sites AI attachment policy + honest text ingestion.
//
// Two jobs:
//  1) UPLOAD POLICY — a strict MIME allowlist + hard size cap, enforced both
//     when issuing a presigned upload URL and again when an attachment is
//     attached to a message. The client cannot widen this.
//  2) INGESTION — download the stored object and extract bounded text so the
//     assistant can actually reason over uploaded content. We follow the
//     repo's deterministic-honest rule: extract real text where we can (PDF,
//     text-family files), and for formats we cannot parse natively (images,
//     docx, etc.) we inject an explicit "content not extracted" note rather
//     than pretending. No silent fallbacks.

import type { MessageAttachment } from "@workspace/db";
import { ObjectStorageService } from "../objectStorage";
import { extractPdfText } from "../pdf-extract";
import { logger } from "../logger";

// Hard cap on a single upload (bytes). Keeps abuse + memory bounded.
export const MAX_UPLOAD_BYTES = 15 * 1024 * 1024; // 15 MB

// MIME allowlist. Text-family + PDF are fully extractable; images are allowed
// for reference/record but are NOT text-extractable (no OCR in this repo).
const EXTRACTABLE_TEXT_MIME = new Set<string>([
  "text/plain",
  "text/csv",
  "text/tab-separated-values",
  "text/markdown",
  "text/html",
  "application/json",
  "application/xml",
  "text/xml",
  "application/x-ndjson",
]);

const PDF_MIME = "application/pdf";

const IMAGE_MIME = new Set<string>([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
]);

export const ALLOWED_UPLOAD_MIME: ReadonlySet<string> = new Set<string>([
  PDF_MIME,
  ...EXTRACTABLE_TEXT_MIME,
  ...IMAGE_MIME,
]);

export interface UploadPolicyError {
  ok: false;
  message: string;
}
export interface UploadPolicyOk {
  ok: true;
}

// Validate a single declared upload (contentType + size) against the policy.
export function checkUploadPolicy(contentType: string, size: number): UploadPolicyOk | UploadPolicyError {
  const mime = contentType.split(";")[0]?.trim().toLowerCase() ?? "";
  if (!ALLOWED_UPLOAD_MIME.has(mime)) {
    return { ok: false, message: `Unsupported file type "${mime || contentType}".` };
  }
  if (!Number.isFinite(size) || size < 0) {
    return { ok: false, message: "Invalid file size." };
  }
  if (size > MAX_UPLOAD_BYTES) {
    return {
      ok: false,
      message: `File too large (max ${Math.floor(MAX_UPLOAD_BYTES / (1024 * 1024))} MB).`,
    };
  }
  return { ok: true };
}

// Validate an array of attachments; returns the first failure (if any).
export function checkAttachmentsPolicy(
  attachments: Pick<MessageAttachment, "contentType" | "size">[],
): UploadPolicyOk | UploadPolicyError {
  for (const a of attachments) {
    const r = checkUploadPolicy(a.contentType, a.size);
    if (!r.ok) return r;
  }
  return { ok: true };
}

// Hard-enforce the policy against the STORED objects (not client-declared
// values). For each attachment, fetch the object's real metadata and validate
// the actual byte size + content type. This closes the bypass where a client
// uploads an oversized/disallowed object via the signed URL but declares a
// small/allowed size+type when attaching it to a message.
export async function verifyStoredAttachments(
  attachments: Pick<MessageAttachment, "objectPath" | "name">[],
): Promise<UploadPolicyOk | UploadPolicyError> {
  if (attachments.length === 0) return { ok: true };
  const storage = new ObjectStorageService();
  for (const att of attachments) {
    try {
      const file = await storage.getObjectEntityFile(att.objectPath);
      const [meta] = await file.getMetadata();
      const realSize = Number(meta.size ?? 0);
      const realType = normalizeMime(String(meta.contentType ?? ""));
      const policy = checkUploadPolicy(realType, realSize);
      if (!policy.ok) {
        return { ok: false, message: `Attachment "${att.name}": ${policy.message}` };
      }
    } catch (err) {
      logger.warn({ err, objectPath: att.objectPath }, "sites-ai stored attachment verify failed");
      return { ok: false, message: `Attachment "${att.name}" could not be verified.` };
    }
  }
  return { ok: true };
}

// Per-attachment + total extraction caps so a huge upload can't blow the prompt.
const PER_ATTACHMENT_CHARS = 6000;
const TOTAL_CONTEXT_CHARS = 18000;

function normalizeMime(contentType: string): string {
  return contentType.split(";")[0]?.trim().toLowerCase() ?? "";
}

// Extract bounded text from one stored attachment. Honest: returns null when
// the format is not natively parseable (caller notes it instead of faking it).
async function extractOne(
  storage: ObjectStorageService,
  att: MessageAttachment,
): Promise<string | null> {
  const mime = normalizeMime(att.contentType);
  try {
    const file = await storage.getObjectEntityFile(att.objectPath);
    // Trust the STORED object's real size, not the client's declared size, so a
    // falsified size can't push us into downloading an oversized object.
    const [meta] = await file.getMetadata();
    const realSize = Number(meta.size ?? 0);
    if (realSize > MAX_UPLOAD_BYTES) {
      logger.warn(
        { objectPath: att.objectPath, realSize },
        "sites-ai attachment exceeds size cap — skipping extraction",
      );
      return null;
    }
    const [buf] = await file.download();
    if (mime === PDF_MIME) {
      const text = await extractPdfText(buf);
      return text ? text.slice(0, PER_ATTACHMENT_CHARS) : "";
    }
    if (EXTRACTABLE_TEXT_MIME.has(mime)) {
      return buf.toString("utf8").slice(0, PER_ATTACHMENT_CHARS);
    }
    // Images / unsupported binary: no native text extraction available.
    return null;
  } catch (err) {
    logger.warn({ err, objectPath: att.objectPath }, "sites-ai attachment extraction failed");
    return null;
  }
}

// Build a bounded context block describing the user's attachments for the
// assistant prompt. Always lists every attachment (name/type/size); inlines
// extracted text where available and is explicit when it is not.
export async function buildAttachmentContext(
  attachments: MessageAttachment[],
): Promise<string> {
  if (attachments.length === 0) return "";
  const storage = new ObjectStorageService();
  const blocks: string[] = [];
  let used = 0;

  for (const att of attachments) {
    const mime = normalizeMime(att.contentType);
    const header = `FILE: "${att.name}" (type=${mime || "unknown"}, ${att.size} bytes)`;
    const text = await extractOne(storage, att);
    if (text === null) {
      blocks.push(
        `${header}\n  [binary file — text could not be extracted; ask the operator to summarize its contents or run OCR upstream if needed]`,
      );
      continue;
    }
    if (text.trim().length === 0) {
      blocks.push(`${header}\n  [no extractable text content]`);
      continue;
    }
    const remaining = TOTAL_CONTEXT_CHARS - used;
    if (remaining <= 0) {
      blocks.push(`${header}\n  [omitted — attachment context limit reached]`);
      continue;
    }
    const clipped = text.slice(0, remaining);
    used += clipped.length;
    const truncated = clipped.length < text.length ? "\n  [...truncated]" : "";
    blocks.push(`${header}\n  ---\n${clipped}${truncated}\n  ---`);
  }

  return [
    "ATTACHMENTS PROVIDED BY THE OPERATOR (extracted content below; use it to inform your reply/proposal):",
    blocks.join("\n\n"),
  ].join("\n");
}
