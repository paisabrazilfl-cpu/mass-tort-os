// Tests for the bg-hub status arbiter — three behaviors we don't want to
// silently regress:
//   (1) STUB_LANES can never return PASS, regardless of empty flags.
//   (2) The `skip` category resolves NOT_RUN when it's the only signal,
//       and loses to review / fail when stronger flags are present.
//   (3) `ofac_unconfigured` (skip) is distinct from `ofac_unavailable`
//       (review) — the criminal_court lane reports NOT_RUN when OFAC is
//       merely not configured but the court check ran clean.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { statusFromFlags, STUB_LANES } from "../bg-hub/escalation";

describe("statusFromFlags — STUB_LANES pin", () => {
  test("phone_provenance (remaining stub) with zero flags resolves REVIEW_REQUIRED (not PASS)", () => {
    // Residency, incarceration, attorney, and business_entity were promoted to
    // live adapters in commit 2e1b6bf — their adapters always emit a real flag,
    // so empty-flag PASS is unreachable in practice. phone_provenance remains
    // the last stub lane.
    const r = statusFromFlags("phone_provenance", []);
    assert.equal(r.status, "REVIEW_REQUIRED");
  });

  test("every stub lane resolves REVIEW_REQUIRED on an empty flag set", () => {
    for (const lane of STUB_LANES) {
      const r = statusFromFlags(lane, []);
      assert.equal(r.status, "REVIEW_REQUIRED", `${lane} must never PASS while it's a stub`);
    }
  });
});

describe("statusFromFlags — criminal_court OFAC skip vs unreachable", () => {
  test("ofac_unconfigured alone → NOT_RUN (config gap, not review)", () => {
    const r = statusFromFlags("criminal_court", ["ofac_unconfigured"]);
    assert.equal(r.status, "NOT_RUN");
    assert.match(r.notes.join(" "), /Sub-source skipped: ofac_unconfigured/);
  });

  test("ofac_unavailable alone → REVIEW_REQUIRED (tried and failed)", () => {
    const r = statusFromFlags("criminal_court", ["ofac_unavailable"]);
    assert.equal(r.status, "REVIEW_REQUIRED");
  });

  test("ofac_unconfigured + court_records_found_review → REVIEW wins", () => {
    // The skip signal is structural; an actual review-worthy court hit
    // takes precedence so the lane doesn't silently downgrade evidence.
    const r = statusFromFlags("criminal_court", [
      "ofac_unconfigured",
      "court_records_found_review",
    ]);
    assert.equal(r.status, "REVIEW_REQUIRED");
  });

  test("ofac_unconfigured + a hard FAIL flag → FAIL wins", () => {
    const r = statusFromFlags("criminal_court", [
      "ofac_unconfigured",
      "confirmed_criminal_match",
    ]);
    assert.equal(r.status, "FAIL");
  });

  test("no flags at all on criminal_court → PASS", () => {
    const r = statusFromFlags("criminal_court", []);
    assert.equal(r.status, "PASS");
  });
});

describe("statusFromFlags — non-stub lane behavior preserved", () => {
  test("address with missing_zip → FAIL", () => {
    const r = statusFromFlags("address", ["missing_zip"]);
    assert.equal(r.status, "FAIL");
  });

  test("email with no_mx_records → FAIL", () => {
    const r = statusFromFlags("email", ["no_mx_records"]);
    assert.equal(r.status, "FAIL");
  });

  test("phone with voip → REVIEW_REQUIRED", () => {
    const r = statusFromFlags("phone", ["voip"]);
    assert.equal(r.status, "REVIEW_REQUIRED");
  });

  test("unknown flag on a real lane routes to REVIEW", () => {
    const r = statusFromFlags("email", ["ufo_signal_detected"]);
    assert.equal(r.status, "REVIEW_REQUIRED");
    assert.match(r.notes.join(" "), /Unknown flags require review/);
  });
});
