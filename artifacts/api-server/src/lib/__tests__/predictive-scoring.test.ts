import test from "node:test";
import assert from "node:assert/strict";
import { scoreLeadRecord, type LeadScoringInput } from "../predictive-scoring";

test("scoreLeadRecord: high-quality lead produces high conversion probability and low risk score", () => {
  const lead: LeadScoringInput = {
    id: 101,
    status: "new",
    tort_type: "roundup",
    fraud_score: 15,
    npi_verified: true,
    diagnosis_confirmed: true,
    was_at_location: true,
    email: "john@example.com",
    phone_primary: "5551234567",
    street_address: "123 Main St",
    ad_spend: 150,
    source: "google_ads",
  };

  const score = scoreLeadRecord(lead);
  assert.equal(score.lead_id, 101);
  assert.equal(score.quality_tier, "platinum");
  assert.equal(score.conversion_probability, 100);
  assert.equal(score.risk_score, 0);
  assert.ok(score.factors.some((f) => f.name === "Fraud Score" && f.impact === 1));
  assert.ok(score.factors.some((f) => f.name === "NPI Verified" && f.impact === 1));
});

test("scoreLeadRecord: low-quality lead produces low conversion probability and high risk score", () => {
  const lead: LeadScoringInput = {
    id: 102,
    status: "new",
    tort_type: "roundup",
    fraud_score: 85,
    npi_verified: false,
    diagnosis_confirmed: false,
    was_at_location: false,
    email: null,
    phone: null,
    street_address: null,
    ad_spend: "0",
    source: "unknown",
  };

  const score = scoreLeadRecord(lead);
  assert.equal(score.lead_id, 102);
  assert.equal(score.quality_tier, "unqualified");
  assert.equal(score.conversion_probability, 0);
  assert.equal(score.risk_score, 100);
  assert.ok(score.factors.some((f) => f.name === "Missing Contact" && f.impact === -1));
  assert.ok(score.factors.some((f) => f.name === "NPI Not Verified" && f.impact === -1));
});
