/**
 * Inbound-fax classification + document retrieval — the DB-free half of the
 * Stage-4 intake (see inbound.ts for the DB orchestration).
 *
 * Kept import-clean (no @workspace/db) on purpose so the classification and
 * SSRF logic — the part that decides whether a webhook is a genuine inbound
 * fax and where to fetch the document — is unit-testable without a database.
 */
import net from "node:net";
import dns from "node:dns/promises";

export const MAX_DOCUMENT_BYTES = 30 * 1024 * 1024; // 30 MB — a long medical record
export const DOWNLOAD_TIMEOUT_MS = 20_000;

// ── Payload field name dictionaries ─────────────────────────────────────────

const DIRECTION_KEYS = ["direction", "Direction"] as const;
const RECEIVED_FLAG_KEYS = ["is_received", "isReceived", "received", "inbound"] as const;
export const FROM_KEYS = [
  "from", "from_number", "fromNumber", "caller_id", "callerid", "caller_number",
  "sender", "remote_id", "remoteid", "originating_number", "ani", "CallerID",
] as const;
export const URL_KEYS = [
  "media_url", "mediaurl", "original_media_url", "originalmediaurl",
  "file_url", "fileurl", "download_url", "downloadurl", "pdf_url", "pdfurl",
  "document_url", "documenturl", "media", "url",
] as const;
export const INLINE_KEYS = [
  "filecontent", "file_content", "pdf_base64", "image_base64",
  "content_base64", "base64", "content",
] as const;

// ── Payload extraction ──────────────────────────────────────────────────────

/**
 * Breadth-first search for the first non-empty string value stored under any
 * of `keys`, anywhere in a (possibly deeply nested) webhook payload. Fax
 * providers disagree wildly on payload shape — some flat, some nested under
 * `data`/`payload`/`event` — so a structural search beats hard-coded paths.
 */
export function deepFindString(root: unknown, keys: readonly string[]): string | null {
  const wanted = new Set(keys.map((k) => k.toLowerCase()));
  const queue: unknown[] = [root];
  let visited = 0;
  while (queue.length > 0 && visited < 500) {
    const node = queue.shift();
    visited++;
    if (!node || typeof node !== "object") continue;
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      if (wanted.has(k.toLowerCase()) && typeof v === "string" && v.trim() !== "") {
        return v.trim();
      }
      if (v && typeof v === "object") queue.push(v);
    }
  }
  return null;
}

/** True iff any of `keys` resolves to a truthy boolean/"true"/1 in the payload. */
export function deepFindTruthy(root: unknown, keys: readonly string[]): boolean {
  const wanted = new Set(keys.map((k) => k.toLowerCase()));
  const queue: unknown[] = [root];
  let visited = 0;
  while (queue.length > 0 && visited < 500) {
    const node = queue.shift();
    visited++;
    if (!node || typeof node !== "object") continue;
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      if (wanted.has(k.toLowerCase())) {
        if (v === true || v === 1) return true;
        if (typeof v === "string" && ["true", "1", "yes"].includes(v.toLowerCase())) return true;
      }
      if (v && typeof v === "object") queue.push(v);
    }
  }
  return false;
}

/** Is this webhook an inbound *received* fax, not an outbound status update? */
export function isInboundReceivedEvent(
  eventType: string,
  status: string | null,
  payload: Record<string, unknown>,
): boolean {
  const dir = deepFindString(payload, DIRECTION_KEYS)?.toLowerCase() ?? "";
  if (dir === "inbound" || dir === "rx" || dir === "receive" || dir === "received") return true;
  if (/receiv/i.test(eventType) || /receiv/i.test(status ?? "")) return true;
  if (deepFindTruthy(payload, RECEIVED_FLAG_KEYS)) return true;
  return false;
}

// ── SSRF-safe document download ─────────────────────────────────────────────

export function isBlockedIp(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split(".").map(Number);
    if (a === 10 || a === 127 || a === 0) return true;
    if (a === 169 && b === 254) return true; // link-local
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
    return false;
  }
  const lower = ip.toLowerCase();
  return lower === "::1" || lower.startsWith("fc") || lower.startsWith("fd") || lower.startsWith("fe80");
}

/** Resolve a webhook-supplied URL and refuse private/internal targets. */
async function assertSafeUrl(raw: string): Promise<URL> {
  let u: URL;
  try { u = new URL(raw); } catch { throw new Error(`invalid media URL`); }
  if (u.protocol !== "https:" && u.protocol !== "http:") {
    throw new Error(`blocked URL scheme '${u.protocol}'`);
  }
  const host = u.hostname.replace(/^\[|\]$/g, "");
  if (!host || host === "localhost") throw new Error(`blocked host '${u.hostname}'`);
  if (net.isIP(host)) {
    if (isBlockedIp(host)) throw new Error(`blocked private IP ${host}`);
    return u;
  }
  const records = await dns.lookup(host, { all: true });
  for (const r of records) {
    if (isBlockedIp(r.address)) throw new Error(`host ${host} resolves to private IP ${r.address}`);
  }
  return u;
}

const MAX_REDIRECTS = 4;

/** Read a response body with a hard byte cap (defends against absent/false content-length). */
async function readCappedBody(resp: Response): Promise<Buffer> {
  const reader = resp.body?.getReader();
  if (!reader) {
    const buf = Buffer.from(await resp.arrayBuffer());
    if (buf.length > MAX_DOCUMENT_BYTES) throw new Error(`media too large (${buf.length} bytes)`);
    return buf;
  }
  const chunks: Buffer[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      total += value.byteLength;
      if (total > MAX_DOCUMENT_BYTES) {
        await reader.cancel().catch(() => {});
        throw new Error(`media too large (>${MAX_DOCUMENT_BYTES} bytes)`);
      }
      chunks.push(Buffer.from(value));
    }
  }
  return Buffer.concat(chunks);
}

/**
 * Download a document from a media URL. Returns the raw bytes.
 *
 * The webhook payload is attacker-controllable (provider signatures on
 * inbound fax webhooks are `unverified`), so the URL — AND every redirect
 * hop — is SSRF-validated. `redirect: "manual"` is mandatory: a public URL
 * that 302s to http://169.254.169.254/ (cloud metadata) would otherwise
 * sail straight past a one-shot check.
 */
async function downloadFromUrl(rawUrl: string): Promise<Buffer> {
  let current = rawUrl;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const safe = await assertSafeUrl(current);
    const resp = await fetch(safe.toString(), {
      redirect: "manual",
      signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
    });
    if (resp.status >= 300 && resp.status < 400) {
      const location = resp.headers.get("location");
      if (!location) throw new Error(`media redirect ${resp.status} with no Location`);
      // Resolve relative redirects against the current URL, then re-validate.
      current = new URL(location, safe).toString();
      continue;
    }
    if (!resp.ok) throw new Error(`media download HTTP ${resp.status}`);
    const declared = Number(resp.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > MAX_DOCUMENT_BYTES) {
      throw new Error(`media too large (${declared} bytes)`);
    }
    const buf = await readCappedBody(resp);
    if (buf.length === 0) throw new Error("media download was empty");
    return buf;
  }
  throw new Error(`media download exceeded ${MAX_REDIRECTS} redirects`);
}

/**
 * Resolve the received document to raw bytes — from a media URL carried in
 * the payload, or from inline base64 content. Returns null when the webhook
 * carries neither (provider needs a separate authenticated fetch call).
 */
export async function retrieveDocument(payload: Record<string, unknown>): Promise<Buffer | null> {
  const url = deepFindString(payload, URL_KEYS);
  if (url && /^https?:\/\//i.test(url)) {
    return downloadFromUrl(url);
  }
  const inline = deepFindString(payload, INLINE_KEYS);
  if (inline) {
    const b64 = inline.replace(/^data:[^;]+;base64,/i, "");
    const buf = Buffer.from(b64, "base64");
    if (buf.length > 0 && buf.length <= MAX_DOCUMENT_BYTES) return buf;
  }
  return null;
}
