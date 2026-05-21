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
