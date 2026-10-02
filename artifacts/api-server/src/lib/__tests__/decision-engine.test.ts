import { test, describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  scoreLead,
  detectContradictions,
  detectRuinFlags,
  detectMissingFields,
  TortInputs,
  SourceInputs,
  EngineSettings,
} from "../decision-engine";

const sampleTort: TortInputs = {
  id: "roundup",
  label: "Roundup NHL",
  avg_settlement_low: 50000,
  avg_settlement_high: 150000,
  expected_duration_months: 24,
  mdl_status: "active",
  sol_months: 36,
  rejection_conditions: [],
  required_exposure: true,
  valid_diagnoses: ["Non-Hodgkin Lymphoma", "NHL", "Lymphoma"],
};

const sampleSource: SourceInputs = {
  name: "Meta Ads LeadGen",
  cost_per_lead: 150,
  historical_qualified_rate: 0.4,
  historical_retained_rate: 0.25,
};

const sampleSettings: EngineSettings = {
  default_attorney_hourly_cost: 250,
  default_hours_per_lead: 2,
  convex_ratio_threshold: 3.0,
  concave_ratio_threshold: 1.0,
  concentration_warning_pct: 40,
  ruin_auto_flag: true,
};

// Recent dates within SOL window (e.g., 6 months ago)
const recentDxDate = new Date(Date.now() - 180 * 24 * 60 * 60 * 1000).toISOString().split("T")[0];
const recentExpStartDate = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000).toISOString().split("T")[0];
const recentExpEndDate = new Date(Date.now() - 200 * 24 * 60 * 60 * 1000).toISOString().split("T")[0];

describe("Decision Engine", () => {
  it("detects contradictions correctly", () => {
    const validLead = {
      diagnosis_date: recentDxDate,
      exposure_start: recentExpStartDate,
      exposure_end: recentExpEndDate,
      date_of_birth: "1970-03-22",
    };
    assert.deepEqual(detectContradictions(validLead), []);

    const invalidLead = {
      diagnosis_date: "2010-01-15",
      exposure_start: "2015-05-10",
      exposure_end: "2012-08-15",
      date_of_birth: "2018-03-22",
    };
    const contradictions = detectContradictions(invalidLead);
    assert.ok(contradictions.includes("diagnosis_before_exposure"));
    assert.ok(contradictions.includes("exposure_end_before_start"));
    assert.ok(contradictions.includes("diagnosis_before_birth"));
  });

  it("detects ruin flags correctly", () => {
    const validLead = {
      diagnosis: "Non-Hodgkin Lymphoma",
      diagnosis_confirmed: true,
      exposure_start: recentExpStartDate,
      state: "CA",
      tort_type: "roundup",
      diagnosis_date: recentDxDate,
      rejection_reason: null,
    };
    assert.deepEqual(detectRuinFlags(validLead, sampleTort), []);

    const invalidLead = {
      diagnosis: "Asthma",
      diagnosis_confirmed: true,
      exposure_start: "2010-01-01",
      state: "CA",
      tort_type: "roundup",
      diagnosis_date: "2010-01-01",
      rejection_reason: "Duplicate",
    };
    const flags = detectRuinFlags(invalidLead, sampleTort);
    assert.ok(flags.includes("sol_expired"));
    assert.ok(flags.includes("diagnosis_invalid"));
    assert.ok(flags.includes("prior_rejection"));
  });

  it("scores valid leads as convex", () => {
    const lead = {
      diagnosis: "Non-Hodgkin Lymphoma",
      diagnosis_confirmed: true,
      exposure_start: recentExpStartDate,
      exposure_end: recentExpEndDate,
      state: "CA",
      tort_type: "roundup",
      diagnosis_date: recentDxDate,
      date_of_birth: "1970-03-22",
      rejection_reason: null,
      source: "Meta Ads LeadGen",
      phone: "555-123-4567",
      email: "john.doe@example.com",
    };

    const res = scoreLead(lead, sampleTort, sampleSource, sampleSettings);
    assert.equal(res.classification, "convex");
    assert.equal(res.action, "execute");
    assert.equal(res.ruin_flags.length, 0);
    assert.equal(res.contradictions.length, 0);
  });
});
