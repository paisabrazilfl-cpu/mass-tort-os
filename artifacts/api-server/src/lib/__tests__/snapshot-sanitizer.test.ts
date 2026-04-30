// Regression tests for the BG hub snapshot sanitizer (lib/bg-hub/snapshot-sanitizer.ts).
//
// Two protection goals:
//   1. Mask helpers do what they claim (unit-level).
//   2. End-to-end: a real hub result, when sanitized, contains zero plaintext
//      PII when serialized to JSON. This is the contract for `lead_background_check_snapshots`.

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { runBackgroundCheckHub } from "../bg-hub/hub.js";
import {
  maskEmail,
  maskPhone,
  maskName,
  maskStreet,
  maskDob,
  maskSsn,
  summarizeRecords,
  sanitizeLaneResult,
  sanitizeHubResultForPersistence,
} from "../bg-hub/snapshot-sanitizer.js";
import type { BackgroundLaneResult } from "../bg-hub/types.js";

describe("snapshot-sanitizer: maskers", () => {
  test("maskEmail keeps first letter + domain", () => {
    assert.equal(maskEmail("alice@example.com"), "a***@example.com");
    assert.equal(maskEmail("bob.smith@corp.io"), "b***@corp.io");
  });

  test("maskEmail returns *** for malformed", () => {
    assert.equal(maskEmail("not-an-email"), "***");
    assert.equal(maskEmail("@nolocal.com"), "***");
  });

  test("maskEmail passes through empty / non-string", () => {
    assert.equal(maskEmail(""), "");
    assert.equal(maskEmail(null), null);
    assert.equal(maskEmail(undefined), undefined);
    assert.equal(maskEmail(42), 42);
  });

  test("maskPhone keeps last 4 digits regardless of formatting", () => {
    assert.equal(maskPhone("5555550199"), "***-***-0199");
    assert.equal(maskPhone("(555) 555-0199"), "***-***-0199");
    assert.equal(maskPhone("+1.555.555.0199"), "***-***-0199");
  });

  test("maskPhone returns *** when no digits present", () => {
    assert.equal(maskPhone("no digits here"), "***");
  });

  test("maskPhone REFUSES to leak ciphertext (regression for bg-hub encrypted-phone bug)", () => {
    // If someone ever forgets to decryptLeadFields() and feeds enc:v1:... in,
    // the masker should NOT leak the ciphertext. It will mask whatever digits
    // it finds in the ciphertext header, but will never echo the cleartext
    // ciphertext string.
    const masked = maskPhone("enc:v1:1:ZLLXTrVZNuuT/TTrtYVjh==");
    assert.match(String(masked), /^\*\*\*-\*\*\*-/);
    assert.notEqual(masked, "enc:v1:1:ZLLXTrVZNuuT/TTrtYVjh==");
  });

  test("maskName keeps first letter of each word", () => {
    assert.equal(maskName("John Doe"), "J*** D***");
    assert.equal(maskName("Maria  Elena   Garcia"), "M*** E*** G***");
  });

  test("maskName passes through empty/whitespace", () => {
    assert.equal(maskName(""), "");
    assert.equal(maskName("   "), "   ");
  });

  test("maskStreet redacts entirely", () => {
    assert.equal(maskStreet("314 Deer Creek Rd"), "*** ***");
  });

  test("maskDob keeps year only", () => {
    assert.equal(maskDob("1985-06-15"), "1985-**-**");
    assert.equal(maskDob("2001-12-31"), "2001-**-**");
  });

  test("maskDob returns *** for non-year inputs", () => {
    assert.equal(maskDob("June 15"), "***");
  });

  test("maskSsn always redacts entirely", () => {
    assert.equal(maskSsn("123-45-6789"), "***");
    assert.equal(maskSsn("6789"), "***");
  });

  test("summarizeRecords replaces array contents with count", () => {
    const got = summarizeRecords([{ defendant: "X" }, { defendant: "Y" }, { defendant: "Z" }]);
    assert.deepEqual(got, { count: 3, redacted: true });
  });

  test("summarizeRecords passes non-arrays through", () => {
    assert.equal(summarizeRecords("hello"), "hello");
    assert.equal(summarizeRecords(null), null);
  });
});

describe("snapshot-sanitizer: sanitizeLaneResult", () => {
  test("preserves verdict, score, flags, notes, sources — only masks raw", () => {
    const lane: BackgroundLaneResult = {
      lane: "phone",
      status: "FAIL",
      score: 0,
      flags: ["invalid_phone_format"],
      notes: ["Hard failure: invalid_phone_format"],
      sources: [],
      checked_at: "2026-04-29T12:00:00.000Z",
      raw: { input: "5555550199", normalized: "5555550199" },
    };
    const out = sanitizeLaneResult(lane);
    assert.equal(out.status, "FAIL");
    assert.equal(out.score, 0);
    assert.deepEqual(out.flags, ["invalid_phone_format"]);
    assert.deepEqual(out.notes, ["Hard failure: invalid_phone_format"]);
    assert.deepEqual(out.raw, { input: "***-***-0199", normalized: "***-***-0199" });
  });

  test("nested raw payloads are walked recursively", () => {
    const lane: BackgroundLaneResult = {
      lane: "criminal_court",
      status: "PASS",
      score: 100,
      flags: [],
      notes: [],
      sources: [],
      checked_at: "2026-04-29T12:00:00.000Z",
      raw: {
        searched_name: "John Doe",
        searched_state: "CA",
        records: [{ defendant_name: "John Doe", court: "casd" }],
        nested: { email: "alice@example.com" },
      },
    };
    const out = sanitizeLaneResult(lane);
    const r = out.raw as Record<string, unknown>;
    assert.equal(r.searched_name, "J*** D***");
    assert.equal(r.searched_state, "CA"); // state preserved
    assert.deepEqual(r.records, { count: 1, redacted: true });
    assert.deepEqual(r.nested, { email: "a***@example.com" });
  });

  test("undefined raw passes through unchanged", () => {
    const lane: BackgroundLaneResult = {
      lane: "phone",
      status: "PASS",
      score: 100,
      flags: [],
      notes: [],
      sources: [],
      checked_at: "2026-04-29T12:00:00.000Z",
    };
    const out = sanitizeLaneResult(lane);
    assert.equal(out.raw, undefined);
  });

  test("does not mutate input", () => {
    const lane: BackgroundLaneResult = {
      lane: "email",
      status: "PASS",
      score: 100,
      flags: [],
      notes: [],
      sources: [],
      checked_at: "2026-04-29T12:00:00.000Z",
      raw: { email: "alice@example.com" },
    };
    sanitizeLaneResult(lane);
    assert.deepEqual(lane.raw, { email: "alice@example.com" });
  });
});

describe("snapshot-sanitizer: end-to-end leak guard", () => {
  test("sanitized hub result for a PII-rich lead contains NO plaintext PII when serialized", async () => {
    // Run a real hub against a lead carrying every kind of sensitive field
    // we mask. Then sanitize and assert the resulting JSON string is
    // PII-free. This is the contract for what gets persisted into
    // `lead_background_check_snapshots`.
    const result = await runBackgroundCheckHub({
      id: 999999,
      first_name: "Alicia",
      last_name: "RodriguezTestUnique",
      full_name: "Alicia RodriguezTestUnique",
      email: "alicia.rodriguezunique@piltest.example",
      phone: "5125550173",
      address: "1428 Elm Street Apt 7B",
      city: "Springfield",
      state: "IL",
      zip: "62704",
      dob: "1985-06-15",
      business_name: null,
    });
    const sanitized = sanitizeHubResultForPersistence(result);
    const json = JSON.stringify(sanitized);

    // Plaintext PII strings that MUST NOT appear anywhere in the serialized snapshot:
    const forbiddenSubstrings = [
      "alicia.rodriguezunique@piltest.example", // full email
      "5125550173", // phone digits as a contiguous run
      "1428 Elm Street", // street
      "1985-06-15", // full DOB
      "Alicia RodriguezTestUnique", // full name
      "RodriguezTestUnique", // last name alone is also distinctive
    ];
    for (const needle of forbiddenSubstrings) {
      assert.equal(
        json.includes(needle),
        false,
        `sanitized snapshot must not contain plaintext PII "${needle}"`,
      );
    }

    // Audit metadata must still be present in some form so operators can
    // verify "the right person was looked up". Loose evidence — exact lane
    // shapes vary as adapters evolve.
    assert.equal(typeof sanitized.final_status, "string");
    assert.equal(typeof sanitized.overall_score, "number");
    assert.ok(Array.isArray(sanitized.results));
    assert.ok(sanitized.results.length > 0);
  });

  test("verdict, score, summary, and flags are preserved exactly across sanitization", async () => {
    const result = await runBackgroundCheckHub({
      id: 999998,
      first_name: "Bob",
      last_name: "Smith",
      full_name: "Bob Smith",
      email: "bob@example.org",
      phone: "5125551234",
      address: "100 Oak St",
      city: "Austin",
      state: "TX",
      zip: "78701",
      dob: "1970-01-01",
      business_name: null,
    });
    const sanitized = sanitizeHubResultForPersistence(result);
    assert.equal(sanitized.final_status, result.final_status);
    assert.equal(sanitized.overall_score, result.overall_score);
    assert.deepEqual(sanitized.summary, result.summary);
    for (let i = 0; i < result.results.length; i++) {
      const a = result.results[i]!;
      const b = sanitized.results[i]!;
      assert.equal(b.lane, a.lane, `lane[${i}].lane preserved`);
      assert.equal(b.status, a.status, `lane[${i}].status preserved`);
      assert.equal(b.score, a.score, `lane[${i}].score preserved`);
      assert.deepEqual(b.flags, a.flags, `lane[${i}].flags preserved`);
      assert.deepEqual(b.notes, a.notes, `lane[${i}].notes preserved`);
    }
  });
});
