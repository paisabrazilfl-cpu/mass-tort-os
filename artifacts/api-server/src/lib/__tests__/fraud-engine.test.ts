import { test } from "node:test";
import assert from "node:assert/strict";
import { runFraudDetection } from "../fraud-engine";

test("runFraudDetection correctly identifies no fraud", () => {
  const context = {
    lead_data: {
      date_of_birth: "1980-05-12",
      diagnosis_date: "2020-03-15",
      exposure_start: "1985-01-01",
      diagnosis: "Non-Hodgkin Lymphoma",
      tort_type: "Roundup",
      physician_first_name: "John",
      physician_last_name: "Doe",
    },
    tort_validation: {
      diagnosis_match: true,
      errors: [],
    } as any,
    taxonomy_match: null,
    npi_found: true,
  };

  const result = runFraudDetection(context);
  assert.equal(result.hard_block, false);
  assert.equal(result.hard_block_reason, null);
  assert.equal(result.has_flags, false);
  assert.equal(result.fraud_score, 0);
  assert.equal(result.indicators.length, 0);
  assert.equal(result.summary, "No fraud indicators detected");
});

test("runFraudDetection detects impossible timeline and taxonomy mismatch", () => {
  const context = {
    lead_data: {
      date_of_birth: "2010-05-12",
      diagnosis_date: "2005-03-15", // Before birth
      exposure_start: "2008-01-01",
      diagnosis: "Mesothelioma",
      tort_type: "Roundup",
      physician_first_name: "Jane",
      physician_last_name: "Smith",
    },
    tort_validation: {
      diagnosis_match: false,
      errors: ["NO_EXPOSURE", "EXPOSURE_OUTSIDE_1953_1987"],
    } as any,
    taxonomy_match: {
      fraud_indicators: [
        "TAXONOMY_MISMATCH",
        "PEDIATRIC_PHYSICIAN_ADULT_CONDITION",
        "SPECIALTY_OUTSIDE_SCOPE",
        "NON_MEDICAL_PROVIDER",
      ],
      physician_specialty: "Pediatrics",
      diagnosis_category: "Oncology",
    } as any,
    npi_found: false,
  };

  const result = runFraudDetection(context);
  assert.equal(result.hard_block, true);
  assert.equal(result.hard_block_reason, "IMPOSSIBLE_TIMELINE");
  assert.equal(result.has_flags, true);
  assert.equal(result.fraud_score, 100); // capped at 100
  assert(result.indicators.length > 0);
  assert(result.summary.includes("fraud indicator(s) found"));
});

test("runFraudDetection handles adult condition under 5 years old", () => {
  const context = {
    lead_data: {
      date_of_birth: "2020-01-01",
      diagnosis_date: "2022-01-01", // age 2
      diagnosis: "Mesothelioma patient",
    },
    tort_validation: {
      diagnosis_match: true,
      errors: [],
    } as any,
    taxonomy_match: null,
    npi_found: true,
  };

  const result = runFraudDetection(context);
  assert.equal(result.hard_block, true);
  assert.equal(result.hard_block_reason, "IMPOSSIBLE_MEDICAL_TIMELINE");
});
