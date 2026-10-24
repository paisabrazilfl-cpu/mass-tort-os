import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  detectContradictions,
  detectRuinFlags,
  detectMissingFields,
  scoreLead,
  buildPortfolio,
  type TortInputs,
  type SourceInputs,
  type EngineSettings,
} from "../decision-engine";

const sampleTort: TortInputs = {
  id: "roundup",
  label: "Roundup Weedkiller",
  avg_settlement_low: 50000,
  avg_settlement_high: 150000,
  expected_duration_months: 24,
  mdl_status: "active_bellwether",
  sol_months: 36,
  rejection_conditions: ["no_exposure"],
  required_exposure: true,
  valid_diagnoses: ["Non-Hodgkin Lymphoma", "NHL", "B-cell Lymphoma"],
};

const sampleSource: SourceInputs = {
  name: "Google Ads",
  cost_per_lead: 250,
  historical_qualified_rate: 0.6,
  historical_retained_rate: 0.35,
};

const sampleSettings: EngineSettings = {
  default_attorney_hourly_cost: 250,
  default_hours_per_lead: 8,
  convex_ratio_threshold: 5,
  concave_ratio_threshold: 1.5,
  concentration_warning_pct: 40,
  ruin_auto_flag: false,
};

const recentDateStr = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString().slice(0, 10);
const recentExposureStart = new Date(Date.now() - 365 * 24 * 3600 * 1000).toISOString().slice(0, 10);

describe("decision-engine", () => {
  describe("detectContradictions", () => {
    it("returns empty array for valid chronological lead data", () => {
      const lead = {
        diagnosis_date: recentDateStr,
        exposure_start: recentExposureStart,
        exposure_end: recentDateStr,
        date_of_birth: "1975-11-20",
      };
      const contradictions = detectContradictions(lead as any);
      assert.deepEqual(contradictions, []);
    });

    it("detects diagnosis_before_exposure", () => {
      const lead = {
        diagnosis_date: "2010-01-01",
        exposure_start: "2015-05-01",
        exposure_end: "2020-08-15",
        date_of_birth: "1975-11-20",
      };
      const contradictions = detectContradictions(lead as any);
      assert.ok(contradictions.includes("diagnosis_before_exposure"));
    });

    it("detects exposure_end_before_start", () => {
      const lead = {
        diagnosis_date: recentDateStr,
        exposure_start: "2020-05-01",
        exposure_end: "2015-08-15",
        date_of_birth: "1975-11-20",
      };
      const contradictions = detectContradictions(lead as any);
      assert.ok(contradictions.includes("exposure_end_before_start"));
    });

    it("detects diagnosis_in_future and birth_in_future", () => {
      const lead = {
        diagnosis_date: "2099-01-01",
        exposure_start: "2015-05-01",
        exposure_end: "2020-08-15",
        date_of_birth: "2099-01-01",
      };
      const contradictions = detectContradictions(lead as any);
      assert.ok(contradictions.includes("diagnosis_in_future"));
      assert.ok(contradictions.includes("birth_in_future"));
    });

    it("detects diagnosis_before_birth", () => {
      const lead = {
        diagnosis_date: "1970-01-01",
        exposure_start: "2015-05-01",
        exposure_end: "2020-08-15",
        date_of_birth: "1975-11-20",
      };
      const contradictions = detectContradictions(lead as any);
      assert.ok(contradictions.includes("diagnosis_before_birth"));
    });
  });

  describe("detectRuinFlags", () => {
    it("returns no flags for clean lead", () => {
      const lead = {
        diagnosis: "Non-Hodgkin Lymphoma",
        diagnosis_confirmed: true,
        exposure_start: recentExposureStart,
        state: "CA",
        tort_type: "roundup",
        diagnosis_date: recentDateStr,
        rejection_reason: null,
      };
      const flags = detectRuinFlags(lead as any, sampleTort);
      assert.deepEqual(flags, []);
    });

    it("flags sol_expired when diagnosis_date exceeds sol_months", () => {
      const lead = {
        diagnosis: "Non-Hodgkin Lymphoma",
        diagnosis_confirmed: true,
        exposure_start: "2010-01-01",
        state: "CA",
        tort_type: "roundup",
        diagnosis_date: "2010-01-01",
        rejection_reason: null,
      };
      const flags = detectRuinFlags(lead as any, sampleTort);
      assert.ok(flags.includes("sol_expired"));
    });

    it("flags mdl_closed", () => {
      const closedTort = { ...sampleTort, mdl_status: "closed" };
      const lead = {
        diagnosis: "Non-Hodgkin Lymphoma",
        diagnosis_confirmed: true,
        exposure_start: recentExposureStart,
        state: "CA",
        tort_type: "roundup",
        diagnosis_date: recentDateStr,
        rejection_reason: null,
      };
      const flags = detectRuinFlags(lead as any, closedTort);
      assert.ok(flags.includes("mdl_closed"));
    });

    it("flags diagnosis_invalid when diagnosis does not match valid_diagnoses", () => {
      const lead = {
        diagnosis: "Broken Leg",
        diagnosis_confirmed: true,
        exposure_start: recentExposureStart,
        state: "CA",
        tort_type: "roundup",
        diagnosis_date: recentDateStr,
        rejection_reason: null,
      };
      const flags = detectRuinFlags(lead as any, sampleTort);
      assert.ok(flags.includes("diagnosis_invalid"));
    });

    it("flags exposure_missing when required_exposure is true but exposure_start is missing", () => {
      const lead = {
        diagnosis: "Non-Hodgkin Lymphoma",
        diagnosis_confirmed: true,
        exposure_start: null,
        state: "CA",
        tort_type: "roundup",
        diagnosis_date: recentDateStr,
        rejection_reason: null,
      };
      const flags = detectRuinFlags(lead as any, sampleTort);
      assert.ok(flags.includes("exposure_missing"));
    });

    it("flags prior_rejection when rejection_reason is present", () => {
      const lead = {
        diagnosis: "Non-Hodgkin Lymphoma",
        diagnosis_confirmed: true,
        exposure_start: recentExposureStart,
        state: "CA",
        tort_type: "roundup",
        diagnosis_date: recentDateStr,
        rejection_reason: "duplicate_claim",
      };
      const flags = detectRuinFlags(lead as any, sampleTort);
      assert.ok(flags.includes("prior_rejection"));
    });
  });

  describe("detectMissingFields", () => {
    it("returns missing fields when critical fields are blank", () => {
      const lead = {
        diagnosis: "",
        diagnosis_date: " ",
        state: null,
        phone: null,
        email: null,
        exposure_start: null,
      };
      const missing = detectMissingFields(lead as any, sampleTort);
      assert.deepEqual(missing, ["diagnosis", "diagnosis_date", "state", "contact", "exposure_start"]);
    });

    it("returns empty array when all required fields are present", () => {
      const lead = {
        diagnosis: "NHL",
        diagnosis_date: recentDateStr,
        state: "CA",
        phone: "555-1234",
        email: null,
        exposure_start: recentExposureStart,
      };
      const missing = detectMissingFields(lead as any, sampleTort);
      assert.deepEqual(missing, []);
    });
  });

  describe("scoreLead", () => {
    it("calculates score correctly for valid convex lead", () => {
      const lead = {
        diagnosis: "Non-Hodgkin Lymphoma (Cancer)",
        diagnosis_confirmed: true,
        exposure_start: recentExposureStart,
        exposure_end: recentDateStr,
        state: "CA",
        tort_type: "roundup",
        diagnosis_date: recentDateStr,
        date_of_birth: "1980-01-01",
        rejection_reason: null,
        source: "Google Ads",
        phone: "555-1234",
        email: "test@example.com",
      };
      const result = scoreLead(lead as any, sampleTort, sampleSource, sampleSettings);
      assert.equal(result.classification, "convex");
      assert.equal(result.action, "execute");
      assert.equal(result.ruin_flags.length, 0);
      assert.equal(result.contradictions.length, 0);
    });
  });

  describe("buildPortfolio", () => {
    it("builds portfolio summary correctly", () => {
      const leadsByTort = new Map([
        [
          "roundup",
          {
            lead_count: 100,
            total_spend: 10000,
            qualified: 60,
            retained: 30,
            ruin_flag_count: 2,
            convex_count: 80,
            concave_count: 10,
          },
        ],
      ]);
      const torts = new Map([["roundup", sampleTort]]);
      const summary = buildPortfolio(leadsByTort, torts, sampleSettings);
      assert.equal(summary.tort_count, 1);
      assert.equal(summary.total_spend_usd, 10000);
      assert.equal(summary.rows[0].tort_id, "roundup");
    });
  });
});
