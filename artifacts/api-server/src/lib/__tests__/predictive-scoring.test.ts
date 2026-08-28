import { test } from "node:test";
import assert from "node:assert/strict";
import { scoreLeadFromRow } from "../predictive-scoring";
import type { leadsTable } from "@workspace/db";

type LeadSelect = typeof leadsTable.$inferSelect;

function createMockLead(overrides: Partial<LeadSelect> = {}): LeadSelect {
  return {
    id: 101,
    firm_id: 1,
    status: "new",
    tort_type: "roundup",
    fraud_score: 10,
    npi_verified: true,
    diagnosis_confirmed: true,
    was_at_location: true,
    email: "john@example.com",
    phone: "5551234567",
    phone_primary: "5551234567",
    street_address: "123 Main St",
    ad_spend: "150.00",
    source: "google_ads",
    first_name: "John",
    last_name: "Doe",
    created_at: new Date(),
    updated_at: new Date(),
    lookup_hash: null,
    city: null,
    state: null,
    zip_code: null,
    date_of_birth: null,
    diagnosis: null,
    diagnosis_date: null,
    exposure_start: null,
    exposure_end: null,
    physician_first_name: null,
    physician_last_name: null,
    physician_npi: null,
    notes: null,
    ai_summary: null,
    rejection_reason: null,
    signed_at: null,
    ...overrides,
  } as LeadSelect;
}

test("scoreLeadFromRow: computes high conversion score and platinum tier for ideal lead", () => {
  const lead = createMockLead({
    fraud_score: 15,
    npi_verified: true,
    diagnosis_confirmed: true,
    was_at_location: true,
    email: "clean@example.com",
    phone: "5551234567",
    street_address: "123 Main St",
    ad_spend: "200.00",
    source: "facebook_ads",
  });

  const score = scoreLeadFromRow(lead);

  assert.equal(score.lead_id, 101);
  assert.equal(score.quality_tier, "platinum");
  assert.ok(score.conversion_probability >= 90, `Conversion prob should be high (${score.conversion_probability})`);
  assert.equal(score.risk_score, 0);

  const fraudFactor = score.factors.find((f) => f.name === "Fraud Score");
  assert.ok(fraudFactor);
  assert.equal(fraudFactor?.impact, 1);
});

test("scoreLeadFromRow: computes high risk score and unqualified tier for suspicious lead", () => {
  const lead = createMockLead({
    id: 202,
    fraud_score: 85,
    npi_verified: false,
    diagnosis_confirmed: false,
    was_at_location: false,
    email: null,
    phone: null,
    phone_primary: null,
    street_address: null,
    ad_spend: "0",
    source: "unknown",
  });

  const score = scoreLeadFromRow(lead);

  assert.equal(score.lead_id, 202);
  assert.equal(score.quality_tier, "unqualified");
  assert.equal(score.conversion_probability, 0);
  assert.ok(score.risk_score >= 90, `Risk score should be high (${score.risk_score})`);

  const missingContact = score.factors.find((f) => f.name === "Missing Contact");
  assert.ok(missingContact);
  assert.equal(missingContact?.impact, -1);
});

test("scoreLeadFromRow: handles partial contact info and moderate fraud score", () => {
  const lead = createMockLead({
    id: 303,
    fraud_score: 45,
    npi_verified: true,
    diagnosis_confirmed: false,
    was_at_location: true,
    email: "jane@example.com",
    phone: null,
    phone_primary: null,
    street_address: null,
  });

  const score = scoreLeadFromRow(lead);

  assert.equal(score.lead_id, 303);
  assert.ok(["silver", "bronze", "gold"].includes(score.quality_tier), `Tier should be moderate (${score.quality_tier})`);
  assert.ok(score.conversion_probability > 0);
  assert.ok(score.risk_score > 0);
});
