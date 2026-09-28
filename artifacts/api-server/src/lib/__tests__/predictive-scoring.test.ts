import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { computePredictiveScoreForLead } from "../predictive-scoring";

describe("predictive-scoring", () => {
  test("computes high score for platinum quality lead", () => {
    const score = computePredictiveScoreForLead({
      id: 101,
      status: "new",
      tort_type: "roundup",
      fraud_score: 15,
      npi_verified: true,
      diagnosis_confirmed: true,
      was_at_location: true,
      email: "test@example.com",
      phone: "555-123-4567",
      street_address: "123 Main St",
      ad_spend: 150,
      source: "google_ads",
    });

    assert.equal(score.lead_id, 101);
    assert.equal(score.quality_tier, "platinum");
    assert.ok(score.conversion_probability >= 80);
    assert.ok(score.risk_score <= 20);
    assert.ok(score.factors.some((f) => f.name === "Fraud Score" && f.impact === 1));
    assert.ok(score.factors.some((f) => f.name === "NPI Verified" && f.impact === 1));
    assert.ok(score.factors.some((f) => f.name === "Diagnosis Confirmed" && f.impact === 1));
  });

  test("computes low score / high risk for unqualified lead", () => {
    const score = computePredictiveScoreForLead({
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
      ad_spend: 0,
      source: "unknown",
    });

    assert.equal(score.lead_id, 102);
    assert.equal(score.quality_tier, "unqualified");
    assert.ok(score.risk_score >= 70);
    assert.ok(score.factors.some((f) => f.name === "Fraud Score" && f.impact === -1));
    assert.ok(score.factors.some((f) => f.name === "NPI Not Verified" && f.impact === -1));
    assert.ok(score.factors.some((f) => f.name === "Missing Contact" && f.impact === -1));
  });

  test("handles numeric and string ad_spend gracefully", () => {
    const scoreString = computePredictiveScoreForLead({
      id: 103,
      status: "new",
      tort_type: "roundup",
      fraud_score: 20,
      diagnosis_confirmed: true,
      was_at_location: false,
      ad_spend: "49.99",
    });

    const scoreNumber = computePredictiveScoreForLead({
      id: 104,
      status: "new",
      tort_type: "roundup",
      fraud_score: 20,
      diagnosis_confirmed: true,
      was_at_location: false,
      ad_spend: 49.99,
    });

    assert.equal(scoreString.conversion_probability, scoreNumber.conversion_probability);
  });
});
