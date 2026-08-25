import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { matchTaxonomyToDiagnosis } from "../taxonomy-engine";

describe("taxonomy-engine", () => {
  test("matches hematology/oncology specialty for Non-Hodgkin Lymphoma", () => {
    const result = matchTaxonomyToDiagnosis("Hematology/Oncology", "Non-Hodgkin Lymphoma", "207RH0003X");
    assert.equal(result.matched, true);
    assert.equal(result.diagnosis_category, "hematology");
    assert.equal(result.confidence, "high");
    assert.deepEqual(result.fraud_indicators, []);
  });

  test("flags taxonomy mismatch for dermatology treating cancer", () => {
    const result = matchTaxonomyToDiagnosis("Dermatology", "Lung Cancer");
    assert.equal(result.matched, false);
    assert.equal(result.confidence, "low");
    assert.ok(result.fraud_indicators.includes("TAXONOMY_MISMATCH"));
    assert.ok(result.fraud_indicators.includes("SPECIALTY_OUTSIDE_SCOPE"));
  });

  test("accepts general practice for internal medicine", () => {
    const result = matchTaxonomyToDiagnosis("Family Medicine", "Parkinson's Disease");
    assert.equal(result.matched, true);
    assert.equal(result.confidence, "medium");
  });

  test("flags unrecognized diagnosis", () => {
    const result = matchTaxonomyToDiagnosis("Oncology", "Unknown Condition XYZ");
    assert.equal(result.matched, false);
    assert.deepEqual(result.fraud_indicators, ["UNRECOGNIZED_DIAGNOSIS"]);
  });
});
