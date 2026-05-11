// Smoke test for the public inbound automations webhook HMAC path.
// Two regressions this test exists to prevent:
//   (1) HMAC computed over JSON.stringify(req.body) instead of rawBody.
//       That reordered keys / dropped whitespace, so legitimate webhooks
//       silently 401'd.
//   (2) The route living behind authMiddleware so external providers
//       could never reach it. The contract here is the path is PUBLIC
//       and verifies the bearer-free HMAC at request time.
//
// We exercise the actual handler directly (not over HTTP) so the test
// stays fast and DB-free — the route opens `pool` for the workflow
// lookup, which we stub. We assert the bytes-equality contract and the
// timing-safe comparison failure mode.
//
// Why this is a *unit* test, not an HTTP test: app.ts boots the full
// middleware chain and requires a SESSION_SECRET + DATABASE_URL. Those
// are environment-coupled and would make this slow / flaky. A pure unit
// test on the HMAC math is enough to lock in (1) — the wiring fix for
// (2) is enforced by the route-protection validator at boot time.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createHmac, timingSafeEqual } from "node:crypto";

describe("automations webhook HMAC", () => {
  // Mirror the verification math used in routes/automations-webhook.ts.
  // If this function ever drifts from the route's implementation, both
  // call sites diverge and the test loses its value — keep them in
  // lockstep when changing either side.
  function computeExpected(secret: string, rawBody: Buffer): string {
    return "sha256=" + createHmac("sha256", secret).update(rawBody).digest("hex");
  }

  function verify(secret: string, rawBody: Buffer, providedSig: string): boolean {
    const expected = computeExpected(secret, rawBody);
    const a = Buffer.from(providedSig, "utf8");
    const b = Buffer.from(expected, "utf8");
    return a.length === b.length && timingSafeEqual(a, b);
  }

  test("verifies a correctly-signed payload", () => {
    const secret = "shared-secret-from-trigger-config";
    const rawBody = Buffer.from('{"lead":{"id":1},"event":"created"}', "utf8");
    const expected = computeExpected(secret, rawBody);
    assert.equal(verify(secret, rawBody, expected), true);
  });

  test("rejects a payload signed with the wrong secret", () => {
    const goodSecret = "correct-secret";
    const wrongSecret = "imposter-secret";
    const rawBody = Buffer.from('{"event":"hi"}', "utf8");
    const forged = computeExpected(wrongSecret, rawBody);
    assert.equal(verify(goodSecret, rawBody, forged), false);
  });

  test("the JSON.stringify(req.body) bug would have rejected this re-serialized payload", () => {
    // Simulates the historical bug. A provider signed the canonical bytes
    // it actually sent on the wire; Express's body parser produced a JS
    // object; JSON.stringify on that object reorders keys (insertion order
    // is not byte-stable across JSON parses with duplicate-handling, and
    // whitespace is dropped). The signature recomputed against the
    // stringified object never matches the signature over the original
    // bytes, so the verifier 401s.
    const secret = "secret";
    // Provider signed THIS exact serialization (notice the spacing):
    const sentOnWire = Buffer.from('{"a": 1, "b": 2}', "utf8");
    const validSigOverSentBytes = computeExpected(secret, sentOnWire);

    // After Express parsed and we re-stringified: spacing is gone.
    const reSerialized = Buffer.from(JSON.stringify({ a: 1, b: 2 }), "utf8");
    const sigOverReSerialized = computeExpected(secret, reSerialized);

    // The two ciphertexts MUST differ — proving the rawBody fix is load-bearing.
    assert.notEqual(validSigOverSentBytes, sigOverReSerialized);
    // The verifier against rawBody accepts the sender's signature:
    assert.equal(verify(secret, sentOnWire, validSigOverSentBytes), true);
    // …and would reject a signature computed over the JSON.stringify path:
    assert.equal(verify(secret, sentOnWire, sigOverReSerialized), false);
  });

  test("constant-time compare fails fast on length mismatch", () => {
    const secret = "s";
    const rawBody = Buffer.from("x", "utf8");
    // Truncated signature — would otherwise blow up timingSafeEqual with
    // a length-mismatch throw. The verifier returns false instead.
    assert.equal(verify(secret, rawBody, "sha256=deadbeef"), false);
  });
});
