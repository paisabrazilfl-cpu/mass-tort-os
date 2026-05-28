// Coverage for verifyFastenSignature — the HMAC gate that decides
// whether the /api/webhooks/fasten route is allowed to mutate a
// fasten_connections row. A regression here either lets unsigned
// (or stale-replayed) requests through, or starts rejecting legit
// webhooks because we accidentally tightened the contract.
//
// Three branches the route depends on, plus the two short-circuit
// branches that distinguish "not configured yet" from "we tried but
// the signature was bogus":
//
//   (a) ok            — header timestamp is fresh (<5 min skew) AND
//                       v1 hex matches HMAC-SHA256(secret, "<ts>.<body>")
//   (b) stale         — well-formed signature but timestamp >5 min old
//                       (replay protection)
//   (c) bad_signature — header parses, timestamp fresh, but v1 hex
//                       doesn't match the recomputed digest
//   (d) no_secret     — Fasten not configured at all (route should
//                       quietly ack rather than 401)
//   (e) missing       — header absent or unparseable

import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { verifyFastenSignature } from "../fasten/webhook.js";

const SECRET = "whsec_unit_test_3a9f8b1c2d4e5f60718293a4b5c6d7e8";

function signHeader(rawBody: Buffer, secret: string, timestamp: number): string {
  const v1 = crypto
    .createHmac("sha256", secret)
    .update(`${timestamp}.${rawBody.toString("utf8")}`)
    .digest("hex");
  return `t=${timestamp},v1=${v1}`;
}

test("verifyFastenSignature: 'ok' for a fresh, correctly-signed payload", () => {
  const rawBody = Buffer.from(
    JSON.stringify({ type: "connection.completed", data: { org_connection_id: "oc_abc" } }),
  );
  const ts = Math.floor(Date.now() / 1000);
  const header = signHeader(rawBody, SECRET, ts);
  const status = verifyFastenSignature({ rawBody, header, secret: SECRET });
  assert.equal(status, "ok", "a freshly-signed payload from the configured secret must verify");
});

test("verifyFastenSignature: 'stale' when the timestamp is older than the 5-minute replay window", () => {
  const rawBody = Buffer.from(JSON.stringify({ type: "connection.completed" }));
  // 6 minutes ago — outside the 300-second tolerance hard-coded in webhook.ts.
  const ts = Math.floor(Date.now() / 1000) - 6 * 60;
  const header = signHeader(rawBody, SECRET, ts);
  const status = verifyFastenSignature({ rawBody, header, secret: SECRET });
  assert.equal(
    status,
    "stale",
    "expired timestamps must be rejected as 'stale' even when the v1 hash is mathematically correct — replay protection is what closes the captured-webhook attack",
  );
});

test("verifyFastenSignature: 'bad_signature' when v1 doesn't match the recomputed HMAC", () => {
  const rawBody = Buffer.from(JSON.stringify({ type: "connection.completed" }));
  const ts = Math.floor(Date.now() / 1000);
  // Sign with the WRONG secret so v1 hex is the right shape but wrong value.
  const header = signHeader(rawBody, "whsec_attacker_guess_value_0000000000000000", ts);
  const status = verifyFastenSignature({ rawBody, header, secret: SECRET });
  assert.equal(
    status,
    "bad_signature",
    "a v1 digest signed with the wrong secret must be rejected as 'bad_signature' — never 'ok'",
  );
});

test("verifyFastenSignature: also catches a one-byte tamper of the body after signing", () => {
  // Even more explicit replay/tamper coverage: sign one body, deliver another.
  const original = Buffer.from(JSON.stringify({ type: "connection.completed", n: 1 }));
  const tampered = Buffer.from(JSON.stringify({ type: "connection.completed", n: 2 }));
  const ts = Math.floor(Date.now() / 1000);
  const header = signHeader(original, SECRET, ts);
  const status = verifyFastenSignature({ rawBody: tampered, header, secret: SECRET });
  assert.equal(
    status,
    "bad_signature",
    "if even one byte of the body changes after signing, verification must fail",
  );
});

test("verifyFastenSignature: 'no_secret' when Fasten is not configured", () => {
  const rawBody = Buffer.from(JSON.stringify({ type: "connection.completed" }));
  const ts = Math.floor(Date.now() / 1000);
  const header = signHeader(rawBody, SECRET, ts);
  const status = verifyFastenSignature({ rawBody, header, secret: null });
  assert.equal(
    status,
    "no_secret",
    "with no configured secret the route must short-circuit to 'no_secret' (not 'bad_signature') so the operator can distinguish 'not set up yet' from a real signature failure",
  );
});

test("verifyFastenSignature: 'missing' when the header is absent or unparseable", () => {
  const rawBody = Buffer.from(JSON.stringify({ type: "connection.completed" }));
  // Absent header.
  assert.equal(
    verifyFastenSignature({ rawBody, header: undefined, secret: SECRET }),
    "missing",
    "no Fasten-Signature header must read as 'missing'",
  );
  // Header present but doesn't carry t= and v1=.
  assert.equal(
    verifyFastenSignature({ rawBody, header: "garbage=value", secret: SECRET }),
    "missing",
    "header missing both t= and v1= must read as 'missing' rather than 'bad_signature'",
  );
});
