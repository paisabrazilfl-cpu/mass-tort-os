import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isTrustedFormCert,
  resolveConsentChannel,
  evaluateConsent,
  evaluateEsignCompletion,
} from "../gates";

// ──────────────── isTrustedFormCert ────────────────

test("isTrustedFormCert accepts only real cert.trustedform.com URLs", () => {
  assert.equal(isTrustedFormCert("https://cert.trustedform.com/abc123"), true);
  assert.equal(isTrustedFormCert("http://cert.trustedform.com/abc123"), false);
  assert.equal(isTrustedFormCert("https://trustedform.com/abc123"), false);
  assert.equal(isTrustedFormCert("https://evil.com/cert.trustedform.com"), false);
  assert.equal(isTrustedFormCert(""), false);
  assert.equal(isTrustedFormCert(null), false);
  assert.equal(isTrustedFormCert(undefined), false);
});

// ──────────────── resolveConsentChannel ────────────────

test("resolveConsentChannel honors explicit override first", () => {
  assert.equal(resolveConsentChannel({ override: "voice" }), "voice");
  assert.equal(resolveConsentChannel({ override: "agent" }), "voice");
  assert.equal(resolveConsentChannel({ override: "web" }), "web");
  assert.equal(resolveConsentChannel({ override: "text_email" }), "web");
  assert.equal(resolveConsentChannel({ override: "vendor" }), "vendor");
});

test("resolveConsentChannel derives from contact preference", () => {
  assert.equal(resolveConsentChannel({ contactPreference: "agent" }), "voice");
  assert.equal(resolveConsentChannel({ contactPreference: "text_email" }), "web");
});

test("resolveConsentChannel flags vendor origin", () => {
  assert.equal(resolveConsentChannel({ hasVendor: true }), "vendor");
  assert.equal(resolveConsentChannel({ source: "vendor_portal" }), "vendor");
  assert.equal(resolveConsentChannel({ source: "lead_import" }), "vendor");
});

test("resolveConsentChannel defaults to the strictest web path", () => {
  assert.equal(resolveConsentChannel({}), "web");
  assert.equal(resolveConsentChannel({ source: "unknown" }), "web");
});

// ──────────────── evaluateConsent ────────────────

test("evaluateConsent requires TCPA opt-in on every channel", () => {
  for (const channel of ["web", "vendor", "voice"] as const) {
    const r = evaluateConsent({
      tcpaConsent: false,
      trustedformCertUrl: "https://cert.trustedform.com/x",
      hasRecordedCall: true,
      channel,
    });
    assert.equal(r.valid, false);
    assert.match(r.reason, /TCPA/i);
  }
});

test("evaluateConsent web/vendor need a valid TrustedForm cert", () => {
  const base = { tcpaConsent: true, hasRecordedCall: false };
  assert.equal(
    evaluateConsent({ ...base, channel: "web", trustedformCertUrl: "https://cert.trustedform.com/x" }).valid,
    true,
  );
  assert.equal(
    evaluateConsent({ ...base, channel: "vendor", trustedformCertUrl: "https://cert.trustedform.com/x" }).valid,
    true,
  );
  assert.equal(
    evaluateConsent({ ...base, channel: "web", trustedformCertUrl: "https://not-a-cert.com/x" }).valid,
    false,
  );
  assert.equal(
    evaluateConsent({ ...base, channel: "vendor", trustedformCertUrl: null }).valid,
    false,
  );
});

test("evaluateConsent voice needs a recorded call with transcript", () => {
  const base = { tcpaConsent: true, trustedformCertUrl: null };
  assert.equal(evaluateConsent({ ...base, channel: "voice", hasRecordedCall: true }).valid, true);
  const missing = evaluateConsent({ ...base, channel: "voice", hasRecordedCall: false });
  assert.equal(missing.valid, false);
  assert.match(missing.reason, /recorded/i);
});

// ──────────────── evaluateEsignCompletion ────────────────

test("evaluateEsignCompletion: required template ids must all be signed", () => {
  const envelopes = [
    { template_id: 1, status: "signed" },
    { template_id: 2, status: "signed" },
    { template_id: 3, status: "created" },
  ];
  const r = evaluateEsignCompletion({ envelopes, requiredTemplateIds: [1, 2, 3] });
  assert.equal(r.complete, false);
  assert.deepEqual(r.pendingTemplateIds, [3]);

  const all = evaluateEsignCompletion({
    envelopes: envelopes.map((e) => ({ ...e, status: "signed" })),
    requiredTemplateIds: [1, 2, 3],
  });
  assert.equal(all.complete, true);
  assert.deepEqual(all.pendingTemplateIds, []);
});

test("evaluateEsignCompletion: default mode requires every envelope signed", () => {
  assert.equal(
    evaluateEsignCompletion({ envelopes: [{ template_id: 1, status: "signed" }, { template_id: 2, status: "signed" }] }).complete,
    true,
  );
  assert.equal(
    evaluateEsignCompletion({ envelopes: [{ template_id: 1, status: "signed" }, { template_id: 2, status: "created" }] }).complete,
    false,
  );
});

test("evaluateEsignCompletion: zero envelopes never counts as complete", () => {
  const r = evaluateEsignCompletion({ envelopes: [] });
  assert.equal(r.complete, false);
  assert.equal(r.total, 0);
});

test("evaluateEsignCompletion: minSigned threshold", () => {
  const envelopes = [
    { template_id: 1, status: "signed" },
    { template_id: 2, status: "signed" },
    { template_id: 3, status: "created" },
  ];
  assert.equal(evaluateEsignCompletion({ envelopes, minSigned: 2 }).complete, true);
  assert.equal(evaluateEsignCompletion({ envelopes, minSigned: 3 }).complete, false);
});
