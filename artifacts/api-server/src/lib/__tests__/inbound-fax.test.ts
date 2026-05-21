/**
 * Unit tests for the inbound-fax intake classifier + payload extractor.
 *
 * These exercise the pure logic that gates Stage 4 — no DB, no network — so
 * they run in any environment. The risk they guard:
 *   - a misclassified outbound delivery callback would trigger a spurious
 *     document download;
 *   - a misclassified inbound fax would be silently dropped;
 *   - a missed sender-number field would orphan every received fax;
 *   - a weak SSRF check would let a forged webhook pull internal URLs.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  deepFindString,
  isInboundReceivedEvent,
  isBlockedIp,
  FROM_KEYS,
  URL_KEYS,
} from "../fax/inbound-classify";
import { base64ToBuffer, detectMimeType } from "../ocr-preprocess";

// ── deepFindString ──────────────────────────────────────────────────────────

test("deepFindString finds a top-level key", () => {
  assert.equal(deepFindString({ from: "+15551234567" }, ["from"]), "+15551234567");
});

test("deepFindString finds a deeply nested key (Telnyx data.payload shape)", () => {
  const payload = { data: { event_type: "fax.received", payload: { from: "+15559998888" } } };
  assert.equal(deepFindString(payload, [...FROM_KEYS]), "+15559998888");
});

test("deepFindString is case-insensitive on key names", () => {
  assert.equal(deepFindString({ MediaUrl: "https://x/y.pdf" }, [...URL_KEYS]), "https://x/y.pdf");
});

test("deepFindString skips empty strings and returns null when absent", () => {
  assert.equal(deepFindString({ from: "   " }, ["from"]), null);
  assert.equal(deepFindString({ a: 1 }, ["from"]), null);
});

// ── isInboundReceivedEvent: must ACCEPT genuine inbound faxes ───────────────

test("Telnyx fax.received is classified inbound", () => {
  assert.equal(
    isInboundReceivedEvent("fax.received", null, {
      data: { payload: { direction: "inbound", from: "+15551112222" } },
    }),
    true,
  );
});

test("Phaxio is_received flag is classified inbound", () => {
  assert.equal(
    isInboundReceivedEvent("unknown", null, { is_received: true, fax: { from_number: "+1..." } }),
    true,
  );
});

test("direction=inbound alone is classified inbound", () => {
  assert.equal(isInboundReceivedEvent("unknown", null, { direction: "inbound" }), true);
});

test("status containing 'received' is classified inbound", () => {
  assert.equal(isInboundReceivedEvent("unknown", "Received", {}), true);
});

// ── isInboundReceivedEvent: must REJECT outbound status callbacks ───────────

test("Telnyx fax.delivered (outbound) is NOT inbound", () => {
  assert.equal(
    isInboundReceivedEvent("fax.delivered", "delivered", {
      data: { payload: { direction: "outbound", to: "+15551112222" } },
    }),
    false,
  );
});

test("outbound sending.started is NOT inbound", () => {
  assert.equal(
    isInboundReceivedEvent("fax.sending.started", "sending", { direction: "outbound" }),
    false,
  );
});

test("a fax.failed delivery callback is NOT inbound", () => {
  assert.equal(isInboundReceivedEvent("fax.failed", "failed", {}), false);
});

// ── isBlockedIp: SSRF guard ─────────────────────────────────────────────────

test("isBlockedIp blocks private + loopback + link-local ranges", () => {
  for (const ip of ["10.0.0.1", "127.0.0.1", "192.168.1.1", "172.16.0.1", "169.254.1.1", "100.64.0.1", "::1"]) {
    assert.equal(isBlockedIp(ip), true, `${ip} must be blocked`);
  }
});

test("isBlockedIp allows public IPs", () => {
  for (const ip of ["8.8.8.8", "1.1.1.1", "203.0.113.10"]) {
    assert.equal(isBlockedIp(ip), false, `${ip} must be allowed`);
  }
});

// ── PDF data-URI round-trip — worker.ts process_fax contract ────────────────

test("PDF data-URI: detectMimeType routes to the PDF path", () => {
  const pdf = Buffer.from("%PDF-1.7\nfake medical record\x00\x01\xffEOF", "latin1");
  const stored = `data:application/pdf;base64,${pdf.toString("base64")}`;
  // worker.ts:271 takes the PDF text-extraction branch only when this is
  // exactly "application/pdf" — a bare base64 string would default to png.
  assert.equal(detectMimeType(stored), "application/pdf");
});

test("PDF data-URI: base64ToBuffer strips the data:application/pdf prefix", () => {
  const pdf = Buffer.from("%PDF-1.7\nfake medical record\x00\x01\xffEOF", "latin1");
  const stored = `data:application/pdf;base64,${pdf.toString("base64")}`;
  assert.deepEqual(base64ToBuffer(stored), pdf);
});

test("base64ToBuffer still decodes a bare base64 string (legacy OCR-upload path)", () => {
  const bytes = Buffer.from([0x01, 0x02, 0x03, 0xff, 0x00, 0x42]);
  assert.deepEqual(base64ToBuffer(bytes.toString("base64")), bytes);
});

test("base64ToBuffer still strips a data:image prefix (unchanged behavior)", () => {
  const img = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
  assert.deepEqual(base64ToBuffer(`data:image/png;base64,${img.toString("base64")}`), img);
});
