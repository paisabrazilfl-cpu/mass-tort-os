import test from "node:test";
import assert from "node:assert/strict";
import { runFraudDetection } from "../fraud-engine";
import { TortValidationResult } from "../tort-engine";
import { TaxonomyMatchResult } from "../taxonomy-engine";

test("runFraudDetection returns no flags for valid clean lead", () => {
  const tortValid: TortValidationResult = {
    valid: true,
    tort_id: "roundup",
    diagnosis_match: true,
    category: "Toxic Tort",
    errors: [],
  };

  const taxonomy: TaxonomyMatchResult = {
    matched: true,
    physician_specialty: "Oncology",
    expected_specialties: ["Oncology"],
    diagnosis_category: "Cancer",
    fraud_indicators: [],
    confidence: "high",
  };

  const result = runFraudDetection({
    lead_data: {
      date_of_birth: "1980-01-01",
      diagnosis_date: "2020-05-15",
      exposure_start: "1995-06-01",
      diagnosis: "Non-Hodgkin Lymphoma",
      physician_first_name: "John",
      physician_last_name: "Doe",
      tort_type: "Roundup",
    },
    tort_validation: tortValid,
    taxonomy_match: taxonomy,
    npi_found: true,
  });

  assert.equal(result.hard_block, false);
  assert.equal(result.hard_block_reason, null);
  assert.equal(result.has_flags, false);
  assert.equal(result.fraud_score, 0);
  assert.equal(result.indicators.length, 0);
  assert.equal(result.summary, "No fraud indicators detected");
});

test("runFraudDetection flags IMPOSSIBLE_TIMELINE when diagnosis date is before DOB", () => {
  const result = runFraudDetection({
    lead_data: {
      date_of_birth: "2000-01-01",
      diagnosis_date: "1995-01-01",
      diagnosis: "Cancer",
    },
    tort_validation: { valid: true, tort_id: "test", diagnosis_match: true, category: "Toxic Tort", errors: [] },
    taxonomy_match: null,
    npi_found: true,
  });

  assert.equal(result.hard_block, true);
  assert.equal(result.hard_block_reason, "IMPOSSIBLE_TIMELINE");
  assert.equal(result.has_flags, true);
  assert.equal(result.fraud_score, 100);
  assert.equal(result.indicators.some((i) => i.type === "IMPOSSIBLE_TIMELINE"), true);
});

test("runFraudDetection flags FUTURE_DIAGNOSIS_DATE when diagnosis date is in the future", () => {
  const futureYear = new Date().getFullYear() + 5;
  const result = runFraudDetection({
    lead_data: {
      date_of_birth: "1980-01-01",
      diagnosis_date: `${futureYear}-01-01`,
      diagnosis: "Cancer",
    },
    tort_validation: { valid: true, tort_id: "test", diagnosis_match: true, category: "Toxic Tort", errors: [] },
    taxonomy_match: null,
    npi_found: true,
  });

  assert.equal(result.hard_block, true);
  assert.equal(result.hard_block_reason, "FUTURE_DIAGNOSIS_DATE");
  assert.equal(result.indicators.some((i) => i.type === "FUTURE_DIAGNOSIS_DATE"), true);
});

test("runFraudDetection flags IMPOSSIBLE_MEDICAL_TIMELINE for adult-only condition in young child", () => {
  const result = runFraudDetection({
    lead_data: {
      date_of_birth: "2022-01-01",
      diagnosis_date: "2023-01-01", // age 1
      diagnosis: "Mesothelioma",
    },
    tort_validation: { valid: true, tort_id: "test", diagnosis_match: true, category: "Toxic Tort", errors: [] },
    taxonomy_match: null,
    npi_found: true,
  });

  assert.equal(result.hard_block, true);
  assert.equal(result.hard_block_reason, "IMPOSSIBLE_MEDICAL_TIMELINE");
  assert.equal(result.indicators.some((i) => i.type === "IMPOSSIBLE_MEDICAL_TIMELINE"), true);
});

test("runFraudDetection flags EXPOSURE_BEFORE_BIRTH when exposure start precedes DOB", () => {
  const result = runFraudDetection({
    lead_data: {
      date_of_birth: "1990-01-01",
      diagnosis_date: "2020-01-01",
      exposure_start: "1985-01-01",
    },
    tort_validation: { valid: true, tort_id: "test", diagnosis_match: true, category: "Toxic Tort", errors: [] },
    taxonomy_match: null,
    npi_found: true,
  });

  assert.equal(result.hard_block, true);
  assert.equal(result.hard_block_reason, "EXPOSURE_BEFORE_BIRTH");
  assert.equal(result.indicators.some((i) => i.type === "EXPOSURE_BEFORE_BIRTH"), true);
});

test("runFraudDetection handles taxonomy mismatch flags and score capping", () => {
  const taxonomy: TaxonomyMatchResult = {
    matched: false,
    physician_specialty: "Pediatrics",
    expected_specialties: ["Oncology"],
    diagnosis_category: "Oncology",
    fraud_indicators: [
      "TAXONOMY_MISMATCH",
      "PEDIATRIC_PHYSICIAN_ADULT_CONDITION",
      "SPECIALTY_OUTSIDE_SCOPE",
      "NON_MEDICAL_PROVIDER",
    ],
    confidence: "low",
  };

  const result = runFraudDetection({
    lead_data: {
      physician_first_name: "Jane",
      physician_last_name: "Smith",
    },
    tort_validation: {
      valid: false,
      tort_id: "test",
      diagnosis_match: false,
      category: "Toxic Tort",
      errors: ["NO_EXPOSURE", "EXPOSURE_OUTSIDE_1953_1987"],
    },
    taxonomy_match: taxonomy,
    npi_found: false,
  });

  assert.equal(result.hard_block, false);
  assert.equal(result.has_flags, true);
  assert.equal(result.fraud_score, 100); // capped at 100
  assert.equal(result.indicators.length, 8);
  assert.match(result.summary, /^8 fraud indicator\(s\) found \(score: 100\/100\): /);
});
