import test from "node:test";
import assert from "node:assert/strict";
import { runFraudDetection } from "../fraud-engine";

test("runFraudDetection: valid lead produces no fraud flags", () => {
  const result = runFraudDetection({
    lead_data: {
      date_of_birth: "1980-01-01",
      diagnosis_date: "2020-05-15",
      exposure_start: "2010-01-01",
      diagnosis: "Lung Cancer",
      physician_first_name: "John",
      physician_last_name: "Doe",
      tort_type: "Roundup",
    },
    tort_validation: {
      valid: true,
      tort_id: "roundup",
      diagnosis_match: true,
      errors: [],
      category: "pharmaceutical",
    },
    taxonomy_match: null,
    npi_found: true,
  });

  assert.equal(result.hard_block, false);
  assert.equal(result.hard_block_reason, null);
  assert.equal(result.has_flags, false);
  assert.equal(result.fraud_score, 0);
  assert.equal(result.indicators.length, 0);
  assert.equal(result.summary, "No fraud indicators detected");
});

test("runFraudDetection: impossible timeline (diagnosis before birth)", () => {
  const result = runFraudDetection({
    lead_data: {
      date_of_birth: "2000-01-01",
      diagnosis_date: "1995-01-01",
    },
    tort_validation: { valid: true, tort_id: "roundup", diagnosis_match: true, errors: [], category: "pharmaceutical" },
    taxonomy_match: null,
    npi_found: true,
  });

  assert.equal(result.hard_block, true);
  assert.equal(result.hard_block_reason, "IMPOSSIBLE_TIMELINE");
  assert.equal(result.has_flags, true);
  assert.equal(result.indicators.some((i) => i.type === "IMPOSSIBLE_TIMELINE"), true);
});

test("runFraudDetection: future diagnosis date", () => {
  const futureDate = new Date(Date.now() + 86400000 * 365).toISOString().slice(0, 10);
  const result = runFraudDetection({
    lead_data: {
      date_of_birth: "1990-01-01",
      diagnosis_date: futureDate,
    },
    tort_validation: { valid: true, tort_id: "roundup", diagnosis_match: true, errors: [], category: "pharmaceutical" },
    taxonomy_match: null,
    npi_found: true,
  });

  assert.equal(result.hard_block, true);
  assert.equal(result.hard_block_reason, "FUTURE_DIAGNOSIS_DATE");
  assert.equal(result.has_flags, true);
  assert.equal(result.indicators.some((i) => i.type === "FUTURE_DIAGNOSIS_DATE"), true);
});

test("runFraudDetection: adult-only condition in child under 5", () => {
  const result = runFraudDetection({
    lead_data: {
      date_of_birth: "2020-01-01",
      diagnosis_date: "2022-01-01",
      diagnosis: "Malignant Mesothelioma",
    },
    tort_validation: { valid: true, tort_id: "asbestos", diagnosis_match: true, errors: [], category: "product_liability" },
    taxonomy_match: null,
    npi_found: true,
  });

  assert.equal(result.hard_block, true);
  assert.equal(result.hard_block_reason, "IMPOSSIBLE_MEDICAL_TIMELINE");
  assert.equal(result.has_flags, true);
  assert.equal(result.indicators.some((i) => i.type === "IMPOSSIBLE_MEDICAL_TIMELINE"), true);
});

test("runFraudDetection: exposure before birth", () => {
  const result = runFraudDetection({
    lead_data: {
      date_of_birth: "1980-01-01",
      exposure_start: "1975-01-01",
    },
    tort_validation: { valid: true, tort_id: "roundup", diagnosis_match: true, errors: [], category: "pharmaceutical" },
    taxonomy_match: null,
    npi_found: true,
  });

  assert.equal(result.hard_block, true);
  assert.equal(result.hard_block_reason, "EXPOSURE_BEFORE_BIRTH");
  assert.equal(result.has_flags, true);
  assert.equal(result.indicators.some((i) => i.type === "EXPOSURE_BEFORE_BIRTH"), true);
});

test("runFraudDetection: taxonomy mismatch and missing NPI flags", () => {
  const result = runFraudDetection({
    lead_data: {
      physician_first_name: "Jane",
      physician_last_name: "Smith",
      diagnosis: "Parkinson's Disease",
      tort_type: "Paraquat",
    },
    tort_validation: { valid: false, tort_id: "paraquat", diagnosis_match: false, errors: ["NO_EXPOSURE"], category: "pharmaceutical" },
    taxonomy_match: {
      matched: false,
      physician_specialty: "Dentistry",
      expected_specialties: ["Neurology"],
      diagnosis_category: "Neurology",
      confidence: "low",
      fraud_indicators: ["TAXONOMY_MISMATCH", "NON_MEDICAL_PROVIDER"],
    },
    npi_found: false,
  });

  assert.equal(result.hard_block, false);
  assert.equal(result.has_flags, true);
  assert.equal(result.indicators.some((i) => i.type === "TAXONOMY_MISMATCH"), true);
  assert.equal(result.indicators.some((i) => i.type === "NON_MEDICAL_PROVIDER"), true);
  assert.equal(result.indicators.some((i) => i.type === "NPI_NOT_FOUND"), true);
  assert.equal(result.indicators.some((i) => i.type === "INVALID_TORT_MAPPING"), true);
  assert.equal(result.indicators.some((i) => i.type === "INCONSISTENT_EXPOSURE"), true);
  assert.equal(result.fraud_score, 100); // capped at 100
  assert.ok(result.summary.includes("fraud indicator(s) found"));
});
