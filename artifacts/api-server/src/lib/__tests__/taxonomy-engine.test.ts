import test from "node:test";
import assert from "node:assert/strict";
import { matchTaxonomyToDiagnosis } from "../taxonomy-engine";

test("matchTaxonomyToDiagnosis — recognized match (high confidence)", () => {
  const result = matchTaxonomyToDiagnosis("Medical Oncology", "lung cancer");
  assert.strictEqual(result.matched, true);
  assert.strictEqual(result.confidence, "high");
  assert.strictEqual(result.diagnosis_category, "oncology");
  assert.deepStrictEqual(result.fraud_indicators, []);
});

test("matchTaxonomyToDiagnosis — generalist physician (medium confidence)", () => {
  const result = matchTaxonomyToDiagnosis("Family Medicine", "parkinson disease");
  assert.strictEqual(result.matched, true);
  assert.strictEqual(result.confidence, "medium");
  assert.strictEqual(result.diagnosis_category, "neurology");
  assert.deepStrictEqual(result.fraud_indicators, []);
});

test("matchTaxonomyToDiagnosis — unrecognized diagnosis", () => {
  const result = matchTaxonomyToDiagnosis("General Practice", "unknown fictitious condition");
  assert.strictEqual(result.matched, false);
  assert.strictEqual(result.confidence, "low");
  assert.strictEqual(result.diagnosis_category, null);
  assert.deepStrictEqual(result.fraud_indicators, ["UNRECOGNIZED_DIAGNOSIS"]);
});

test("matchTaxonomyToDiagnosis — pediatric physician with adult condition", () => {
  const result = matchTaxonomyToDiagnosis("Pediatric Care", "mesothelioma");
  assert.strictEqual(result.matched, false);
  assert.strictEqual(result.confidence, "low");
  assert.strictEqual(result.diagnosis_category, "oncology");
  assert.ok(result.fraud_indicators.includes("TAXONOMY_MISMATCH"));
  assert.ok(result.fraud_indicators.includes("PEDIATRIC_PHYSICIAN_ADULT_CONDITION"));
});

test("matchTaxonomyToDiagnosis — dermatology physician with cancer claim", () => {
  const result = matchTaxonomyToDiagnosis("Dermatology Clinic", "breast cancer");
  assert.strictEqual(result.matched, false);
  assert.strictEqual(result.confidence, "low");
  assert.strictEqual(result.diagnosis_category, "oncology");
  assert.ok(result.fraud_indicators.includes("TAXONOMY_MISMATCH"));
  assert.ok(result.fraud_indicators.includes("SPECIALTY_OUTSIDE_SCOPE"));
});

test("matchTaxonomyToDiagnosis — dentist physician", () => {
  const result = matchTaxonomyToDiagnosis("Orthodontist & Dentist", "ovarian cancer");
  assert.strictEqual(result.matched, false);
  assert.strictEqual(result.confidence, "low");
  assert.strictEqual(result.diagnosis_category, "gynecology");
  assert.ok(result.fraud_indicators.includes("TAXONOMY_MISMATCH"));
  assert.ok(result.fraud_indicators.includes("NON_MEDICAL_PROVIDER"));
});

test("matchTaxonomyToDiagnosis — oncology NPI taxonomy override", () => {
  const result = matchTaxonomyToDiagnosis("Dermatology", "breast cancer", "207RH0003X");
  assert.strictEqual(result.matched, true);
  assert.strictEqual(result.confidence, "high");
  assert.strictEqual(result.diagnosis_category, "oncology");
  assert.deepStrictEqual(result.fraud_indicators, []);
});
