import test from "node:test";
import assert from "node:assert/strict";
import {
  computeCompletionScore,
  computeReliabilityScore,
  computeTruthfulnessScore,
} from "../lead-intelligence";

test("computeCompletionScore correctly handles complete lead", () => {
  const completeLead = {
    first_name: "Jane",
    last_name: "Doe",
    date_of_birth: "1980-01-01",
    phone_primary: "5551234567",
    email: "jane@example.com",
    street_address: "123 Main St",
    city: "Austin",
    state: "TX",
    zip: "78701",
    last_4_ssn: "1234",
    tort_type: "Roundup",
    diagnosis: "Non-Hodgkin Lymphoma",
    diagnosis_date: "2020-05-15",
    physician_first_name: "John",
    physician_last_name: "Smith",
    physician_full_address: "456 Medical Pkwy, Austin, TX",
    physician_contact_info: "555-999-8888",
    hospital_name: "Austin General Hospital",
    hospital_fax: "555-999-8889",
    hospital_contact_info: "555-999-8880",
    medications: "Med A",
    exposure_start: "2010-01-01",
    exposure_end: "2019-12-31",
    location_name: "Farm Site A",
    npi_number: "1234567890",
    source: "Web Form",
    law_firm: "Law Office",
    trustedform_cert_url: "https://cert.trustedform.com/test",
    diagnosis_confirmed: true,
    was_at_location: true,
    tcpa_consent: true,
  };

  const res = computeCompletionScore(completeLead);
  assert.equal(res.score, 100);
  assert.deepEqual(res.details, ["All required and supplementary fields are complete"]);
});

test("computeCompletionScore identifies missing fields and decryption errors", () => {
  const incompleteLead = {
    first_name: "John",
    phone_primary: "[DECRYPTION_ERROR]",
    email: "   ",
  };

  const res = computeCompletionScore(incompleteLead);
  assert.ok(res.score < 50);
  assert.ok(res.details.some((d) => d.includes("Missing required field: Primary Phone")));
  assert.ok(res.details.some((d) => d.includes("Missing required field: Email Address")));
});

test("computeReliabilityScore handles document counting without filter allocation", () => {
  const lead = {
    npi_verified: true,
    email_validation_status: "valid",
    address_validation_status: "valid",
    background_check_status: "clean",
    trustedform_cert_url: "https://cert.trustedform.com/test",
    tcpa_consent: true,
  };
  const documents = [
    { id: 1, signed: true },
    { id: 2, signed: false },
    { id: 3, signed: true },
  ];

  const res = computeReliabilityScore(lead, documents);
  assert.equal(res.score, 100); // 50 + 12 + 8 + 8 + 10 + 8 + 10 + 6 + 4 = 116 capped at 100
  assert.ok(res.details.some((d) => d.includes("2 signed document(s) on file")));
});

test("computeTruthfulnessScore evaluates fraud indicators safely", () => {
  const leadWithJson = {
    fraud_score: 5,
    fraud_status: "ACCEPTED",
    fraud_indicators: JSON.stringify(["ip_mismatch", "proxy_detected"]),
    diagnosis_confirmed: true,
    was_at_location: true,
    diagnosis: "Lymphoma",
    diagnosis_date: "2020-01-01",
  };

  const resJson = computeTruthfulnessScore(leadWithJson);
  assert.ok(resJson.details.some((d) => d.includes("2 fraud indicator(s) flagged")));

  const leadWithString = {
    fraud_indicators: "invalid json string indicator",
  };
  const resString = computeTruthfulnessScore(leadWithString);
  assert.ok(resString.details.some((d) => d.includes("Fraud indicators present in record")));
});
