import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildFaxResultsLikePattern,
  parseFaxSourceFile,
  FAX_SOURCE_FILE_TEMPLATE,
} from "../fax-results-matcher.js";

test("buildFaxResultsLikePattern returns lead-scoped LIKE pattern", () => {
  assert.equal(buildFaxResultsLikePattern(42), "med_records_request_lead_42_env_%");
  assert.equal(buildFaxResultsLikePattern(1), "med_records_request_lead_1_env_%");
});

test("buildFaxResultsLikePattern rejects non-positive / non-integer ids", () => {
  for (const bad of [0, -1, 1.5, NaN, Infinity]) {
    assert.throws(() => buildFaxResultsLikePattern(bad as number), /positive integer/);
  }
  // Casts to dodge TS at the call site — runtime guard must still trigger.
  assert.throws(() => buildFaxResultsLikePattern("42" as unknown as number), /positive integer/);
});

test("buildFaxResultsLikePattern guards against prefix-collision (lead 1 vs 12)", () => {
  // The trailing `_env_` literal in the pattern is the critical guard:
  // without it, `lead_1%` would also match `lead_12_env_*.pdf`.
  const pat1 = buildFaxResultsLikePattern(1);
  const pat12 = buildFaxResultsLikePattern(12);
  assert.equal(pat1, "med_records_request_lead_1_env_%");
  assert.equal(pat12, "med_records_request_lead_12_env_%");
  assert.notEqual(pat1, pat12);

  // Sanity-check the producer side: the template lead 12 must NOT match the
  // lead 1 pattern (modeled here as a JS regex of the SQL LIKE semantics).
  const lead1Regex = new RegExp("^med_records_request_lead_1_env_.+$");
  assert.equal(lead1Regex.test(FAX_SOURCE_FILE_TEMPLATE(1, "abc-123")), true);
  assert.equal(lead1Regex.test(FAX_SOURCE_FILE_TEMPLATE(12, "abc-123")), false);
});

test("parseFaxSourceFile round-trips the template", () => {
  const file = FAX_SOURCE_FILE_TEMPLATE(987, "env-uuid-deadbeef");
  const parsed = parseFaxSourceFile(file);
  assert.deepEqual(parsed, { lead_id: 987, envelope_id: "env-uuid-deadbeef" });
});

test("parseFaxSourceFile tolerates envelope ids containing underscores and hyphens", () => {
  const parsed = parseFaxSourceFile("med_records_request_lead_5_env_abc_def-123.pdf");
  assert.deepEqual(parsed, { lead_id: 5, envelope_id: "abc_def-123" });
});

test("parseFaxSourceFile returns null for non-conforming inputs", () => {
  assert.equal(parseFaxSourceFile(null), null);
  assert.equal(parseFaxSourceFile(undefined), null);
  assert.equal(parseFaxSourceFile(""), null);
  assert.equal(parseFaxSourceFile("random.pdf"), null);
  assert.equal(parseFaxSourceFile("med_records_request_lead_X_env_abc.pdf"), null);
  assert.equal(parseFaxSourceFile("med_records_request_lead_0_env_abc.pdf"), null);
  assert.equal(parseFaxSourceFile("med_records_request_lead_5_env_.pdf"), null);
});
