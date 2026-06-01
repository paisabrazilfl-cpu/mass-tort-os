// Unit coverage for `withCanonicalConsent` (Task: lock in the new consent so it
// can never silently revert on existing forms).
//
// The expanded claimant consent is forced onto every form at RENDER time so
// already-published forms — whose stored web_form_config baked in the OLD short
// label — still display the current legal block without a DB migration. If a
// future change weakens `withCanonicalConsent` (stops overriding the label,
// stops forcing the field to a required checkbox, or starts skipping it), legacy
// forms would silently serve stale/incorrect consent text. That is a legal-text
// correctness risk, so this suite pins the contract:
//   (a) ANY `tcpa_consent` field is force-overridden to a required checkbox
//       carrying the canonical CLAIMANT_CONSENT_ACKNOWLEDGMENT, regardless of
//       its stored type / required flag / label.
//   (b) non-consent fields pass through completely untouched.
//   (c) the transform is idempotent and tolerates empty / nullish input.

import { test } from "node:test";
import assert from "node:assert/strict";
import type { WebFormField } from "@workspace/db";
import {
  withCanonicalConsent,
  CLAIMANT_CONSENT_ACKNOWLEDGMENT,
  CONSENT_FIELD_KEY,
} from "../consent-copy.js";

// A legacy consent field as it might sit in an old stored web_form_config:
// wrong type, not required, and the short pre-expansion label.
const LEGACY_CONSENT: WebFormField = {
  key: CONSENT_FIELD_KEY,
  label: "I agree to be contacted about my claim.",
  type: "text",
  section: "contact",
  required: false,
};

const NON_CONSENT_FIELD: WebFormField = {
  key: "full_name",
  label: "Full name",
  type: "text",
  section: "contact",
  required: true,
  placeholder: "Jane Doe",
  max_length: 120,
};

test("(a) force-overrides a legacy tcpa_consent field to a required checkbox with the canonical label", () => {
  const [out] = withCanonicalConsent([LEGACY_CONSENT]);
  assert.equal(out.key, CONSENT_FIELD_KEY);
  assert.equal(out.type, "checkbox", "consent field must be normalized to a checkbox");
  assert.equal(out.required, true, "consent field must always be required");
  assert.equal(
    out.label,
    CLAIMANT_CONSENT_ACKNOWLEDGMENT,
    "consent label must be the canonical acknowledgment, not the stored legacy label",
  );
  assert.notEqual(out.label, LEGACY_CONSENT.label, "the old label must not survive");
});

test("(a') overrides even when the stored consent field already looks required/checkbox but carries an old label", () => {
  const stale: WebFormField = {
    key: CONSENT_FIELD_KEY,
    label: "TCPA consent (old wording).",
    type: "checkbox",
    section: "contact",
    required: true,
  };
  const [out] = withCanonicalConsent([stale]);
  assert.equal(out.label, CLAIMANT_CONSENT_ACKNOWLEDGMENT);
});

test("(b) non-consent fields pass through untouched", () => {
  const [out] = withCanonicalConsent([NON_CONSENT_FIELD]);
  assert.deepEqual(out, NON_CONSENT_FIELD, "a non-consent field must not be modified");
});

test("(b') only the consent field is rewritten in a mixed list, order preserved", () => {
  const out = withCanonicalConsent([NON_CONSENT_FIELD, LEGACY_CONSENT]);
  assert.equal(out.length, 2);
  assert.deepEqual(out[0], NON_CONSENT_FIELD);
  assert.equal(out[1].label, CLAIMANT_CONSENT_ACKNOWLEDGMENT);
  assert.equal(out[1].type, "checkbox");
  assert.equal(out[1].required, true);
});

test("(c) is idempotent — applying twice yields the same canonical field", () => {
  const once = withCanonicalConsent([LEGACY_CONSENT]);
  const twice = withCanonicalConsent(once);
  assert.deepEqual(twice, once);
});

test("(c') tolerates empty and nullish input without throwing", () => {
  assert.deepEqual(withCanonicalConsent([]), []);
  assert.deepEqual(
    withCanonicalConsent(undefined as unknown as WebFormField[]),
    [],
    "a nullish field list must coerce to an empty array, not throw",
  );
});
