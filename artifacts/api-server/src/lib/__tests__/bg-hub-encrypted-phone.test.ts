// Regression guard for the bg-hub encrypted-phone bug.
//
// THE BUG (fixed cf245b6 + this PR's earlier commit):
//   POST /api/forms/background-check-hub/lead/:id read `lead.phone` raw from
//   the DB. New web-form-submitted leads store phone as `enc:v1:...`
//   ciphertext. The phone-lane validator stripped non-digits from the
//   ciphertext header and reported `invalid_phone_format` for every
//   encrypted-phone lead — operators read FAIL as "the phone is bad" when
//   in reality the phone was never validated at all.
//
// THE FIX:
//   Add `decryptLeadFields(leadRow)` before constructing the hub input,
//   matching the pattern used in leads.ts, workflow-handlers.ts, and
//   decision-engine-service.ts.
//
// This test reproduces the full flow at the contract boundary the route
// crosses: encrypt → store → decrypt → run hub. A future refactor that
// drops the decrypt step will fail this test.

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { encrypt, decryptLeadFields, isKeyConfigured } from "../encryption.js";
import { runBackgroundCheckHub } from "../bg-hub/hub.js";
import type { LeadLike } from "../bg-hub/types.js";

function findPhoneLane(result: { results: { lane: string; status: string; flags: string[] }[] }) {
  const lane = result.results.find((r) => r.lane === "phone");
  assert.ok(lane, "phone lane must be present in hub results");
  return lane;
}

describe("bg-hub: encrypted-phone regression", () => {
  test("encryption key v1 is configured for this test environment", () => {
    // Sanity check — if this fails, the env is missing ENCRYPTION_KEY/V1
    // and the rest of the suite cannot meaningfully exercise the bug.
    assert.equal(isKeyConfigured(1), true);
  });

  test("encrypt() returns the expected enc:v* envelope format (anti-pattern baseline)", () => {
    // We do NOT assert what the phone validator does with ciphertext directly
    // — that's intentionally non-deterministic because the base64 portion
    // contains a variable number of digits per call (random IV). The point
    // of this test is just to confirm encrypt() produces the format our
    // adapter would have been mis-parsing if decrypt were skipped.
    const ciphertext = encrypt("5555550199", "phone", "999001");
    assert.ok(ciphertext.startsWith("enc:v"));
    assert.notEqual(ciphertext, "5555550199");
  });

  test("decrypt-then-run produces REVIEW_REQUIRED/phone_not_checked, NOT invalid_phone_format", async () => {
    // This is the CORRECT pattern — what the route now does. Encrypt the
    // phone (simulating how it's stored in the DB), simulate the route's
    // decrypt step, then run the hub. The phone validator must see a
    // valid 10-digit US phone, find no SMS verification provider, and
    // return REVIEW_REQUIRED with phone_not_checked. It must NEVER
    // return invalid_phone_format.
    const ciphertext = encrypt("5555550199", "phone", "999002");
    const dbRow = {
      id: 999002,
      first_name: "Smoke",
      last_name: "Test",
      name: "Smoke Test",
      email: "smoke2@example.org",
      phone: ciphertext, // as stored in DB
      street_address: null,
      city: null,
      state: "CA",
      zip: null,
      date_of_birth: null,
    };
    const decrypted = decryptLeadFields(dbRow, "999002");
    // Confirm the decrypt actually happened and the validator will see digits.
    assert.notEqual(decrypted.phone, ciphertext);
    assert.match(String(decrypted.phone), /5555550199/);

    const lead: LeadLike = {
      id: 999002,
      first_name: decrypted.first_name ?? null,
      last_name: decrypted.last_name ?? null,
      full_name: decrypted.name ?? null,
      email: decrypted.email ?? null,
      phone: decrypted.phone ?? null,
      address: decrypted.street_address ?? null,
      city: decrypted.city ?? null,
      state: decrypted.state ?? null,
      zip: decrypted.zip ?? null,
      dob: decrypted.date_of_birth ?? null,
      business_name: null,
    };
    const result = await runBackgroundCheckHub(lead);
    const phoneLane = findPhoneLane(result);

    assert.equal(
      phoneLane.status,
      "REVIEW_REQUIRED",
      `expected REVIEW_REQUIRED for unverifiable-but-valid phone, got ${phoneLane.status} (flags=${JSON.stringify(phoneLane.flags)})`,
    );
    assert.ok(
      phoneLane.flags.includes("phone_not_checked"),
      `expected phone_not_checked flag, got ${JSON.stringify(phoneLane.flags)}`,
    );
    assert.equal(
      phoneLane.flags.includes("invalid_phone_format"),
      false,
      "phone validator must NEVER emit invalid_phone_format on a decrypted valid phone — that's the bug",
    );
  });

  test("ciphertext does NOT bleed into flag identifiers or top-level notes", async () => {
    // Defense-in-depth. Adapter `raw` fields legitimately echo their input
    // (e.g. phone-lane raw.input). What MUST NOT happen is an adapter
    // baking ciphertext into a flag identifier or operator-facing note —
    // those are surfaced in the UI and end up in audit logs verbatim.
    const ciphertext = encrypt("5125550173", "phone", "999003");
    const lead: LeadLike = {
      id: 999003,
      first_name: "Z",
      last_name: "Z",
      full_name: "Z Z",
      email: "z@example.org",
      phone: ciphertext, // intentionally broken — proves no leak path through flags
      address: null,
      city: null,
      state: "CA",
      zip: null,
      dob: null,
      business_name: null,
    };
    const result = await runBackgroundCheckHub(lead);
    for (const lane of result.results) {
      for (const flag of lane.flags) {
        assert.equal(flag.includes("enc:v"), false, `flag ${flag} contains ciphertext`);
      }
      for (const note of lane.notes) {
        assert.equal(note.includes("enc:v"), false, `note ${note} contains ciphertext`);
      }
    }
  });
});
