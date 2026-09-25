import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { matchTaxonomyToDiagnosis } from "../taxonomy-engine";

describe("taxonomy-engine: matchTaxonomyToDiagnosis", () => {
  test("matches oncology specialty with cancer diagnosis", () => {
    const res = matchTaxonomyToDiagnosis("Medical Oncology", "lung cancer");
    assert.equal(res.matched, true);
    assert.equal(res.confidence, "high");
    assert.equal(res.diagnosis_category, "oncology");
    assert.deepEqual(res.fraud_indicators, []);
  });

  test("handles unrecognized diagnosis", () => {
    const res = matchTaxonomyToDiagnosis("General Surgery", "xyz unknown sickness 123");
    assert.equal(res.matched, false);
    assert.equal(res.confidence, "low");
    assert.equal(res.diagnosis_category, null);
    assert.deepEqual(res.fraud_indicators, ["UNRECOGNIZED_DIAGNOSIS"]);
  });

  test("allows generalist for specialized diagnosis with medium confidence", () => {
    const res = matchTaxonomyToDiagnosis("Family Medicine Physician", "parkinsons");
    assert.equal(res.matched, true);
    assert.equal(res.confidence, "medium");
    assert.equal(res.diagnosis_category, "neurology");
    assert.deepEqual(res.fraud_indicators, []);
  });

  test("flags pediatric physician treating adult condition", () => {
    const res = matchTaxonomyToDiagnosis("Pediatrician", "carcinoma");
    assert.equal(res.matched, false);
    assert.equal(res.confidence, "low");
    assert.ok(res.fraud_indicators.includes("TAXONOMY_MISMATCH"));
    assert.ok(res.fraud_indicators.includes("PEDIATRIC_PHYSICIAN_ADULT_CONDITION"));
  });

  test("flags dermatology physician for cancer claim", () => {
    const res = matchTaxonomyToDiagnosis("Dermatology", "mesothelioma");
    assert.equal(res.matched, false);
    assert.equal(res.confidence, "low");
    assert.ok(res.fraud_indicators.includes("TAXONOMY_MISMATCH"));
    assert.ok(res.fraud_indicators.includes("SPECIALTY_OUTSIDE_SCOPE"));
  });

  test("flags dentist as non-medical provider for medical diagnosis", () => {
    const res = matchTaxonomyToDiagnosis("Orthodontist", "gastroparesis");
    assert.equal(res.matched, false);
    assert.equal(res.confidence, "low");
    assert.ok(res.fraud_indicators.includes("TAXONOMY_MISMATCH"));
    assert.ok(res.fraud_indicators.includes("NON_MEDICAL_PROVIDER"));
  });

  test("matches NPI taxonomy code for oncology", () => {
    const res = matchTaxonomyToDiagnosis("Unknown Specialty", "colorectal cancer", "207RH0003X");
    assert.equal(res.matched, true);
    assert.equal(res.confidence, "high");
    assert.equal(res.diagnosis_category, "oncology");
    assert.deepEqual(res.fraud_indicators, []);
  });
});
