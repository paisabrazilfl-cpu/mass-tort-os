import test from "node:test";
import assert from "node:assert/strict";
import {
  scoreLead,
  detectContradictions,
  detectRuinFlags,
  detectMissingFields,
  buildPortfolio,
  TortInputs,
  SourceInputs,
  EngineSettings,
} from "../decision-engine";
import type { Lead } from "@workspace/db";

const mockTort: TortInputs = {
  id: "roundup",
  label: "Roundup",
  avg_settlement_low: 50000,
  avg_settlement_high: 150000,
  expected_duration_months: 24,
  mdl_status: "active_bellwether",
  sol_months: 36,
  rejection_conditions: [],
  required_exposure: true,
  valid_diagnoses: ["Non-Hodgkin Lymphoma", "NHL", "Chronic Lymphocytic Leukemia"],
};

const mockSource: SourceInputs = {
  name: "Google Ads",
  cost_per_lead: 250,
  historical_qualified_rate: 0.6,
  historical_retained_rate: 0.35,
};

const mockSettings: EngineSettings = {
  default_attorney_hourly_cost: 350,
  default_hours_per_lead: 1.5,
  convex_ratio_threshold: 3.0,
  concave_ratio_threshold: 1.0,
  concentration_warning_pct: 30,
  ruin_auto_flag: true,
};

test("detectContradictions", async (t) => {
  await t.test("returns no contradictions for valid timeline", () => {
    const lead = {
      diagnosis_date: "2021-08-20",
      exposure_start: "2015-05-10",
      exposure_end: "2020-01-15",
      date_of_birth: "1975-03-12",
    };
    const res = detectContradictions(lead);
    assert.deepEqual(res, []);
  });

  await t.test("detects diagnosis before exposure", () => {
    const lead = {
      diagnosis_date: "2010-01-01",
      exposure_start: "2015-05-10",
      exposure_end: null,
      date_of_birth: "1975-03-12",
    };
    const res = detectContradictions(lead);
    assert.ok(res.includes("diagnosis_before_exposure"));
  });

  await t.test("detects exposure_end_before_start", () => {
    const lead = {
      diagnosis_date: "2021-08-20",
      exposure_start: "2020-05-10",
      exposure_end: "2015-01-15",
      date_of_birth: "1975-03-12",
    };
    const res = detectContradictions(lead);
    assert.ok(res.includes("exposure_end_before_start"));
  });

  await t.test("detects future dates", () => {
    const futureYear = new Date().getFullYear() + 5;
    const lead = {
      diagnosis_date: `${futureYear}-08-20`,
      exposure_start: "2015-05-10",
      exposure_end: null,
      date_of_birth: "1975-03-12",
    };
    const res = detectContradictions(lead);
    assert.ok(res.includes("diagnosis_in_future"));
  });

  await t.test("detects diagnosis before birth", () => {
    const lead = {
      diagnosis_date: "1970-01-01",
      exposure_start: "1980-05-10",
      exposure_end: null,
      date_of_birth: "1975-03-12",
    };
    const res = detectContradictions(lead);
    assert.ok(res.includes("diagnosis_before_birth"));
  });
});

test("detectRuinFlags", async (t) => {
  await t.test("flags expired SOL", () => {
    const lead = {
      diagnosis: "Non-Hodgkin Lymphoma",
      diagnosis_confirmed: true,
      exposure_start: "2010-01-01",
      state: "CA",
      tort_type: "Roundup",
      diagnosis_date: "2010-01-01",
      rejection_reason: null,
    };
    const res = detectRuinFlags(lead, mockTort);
    assert.ok(res.includes("sol_expired"));
  });

  await t.test("flags invalid diagnosis", () => {
    const lead = {
      diagnosis: "Broken Arm",
      diagnosis_confirmed: true,
      exposure_start: "2020-01-01",
      state: "CA",
      tort_type: "Roundup",
      diagnosis_date: "2022-01-01",
      rejection_reason: null,
    };
    const res = detectRuinFlags(lead, mockTort);
    assert.ok(res.includes("diagnosis_invalid"));
  });

  await t.test("flags missing exposure when required", () => {
    const lead = {
      diagnosis: "Non-Hodgkin Lymphoma",
      diagnosis_confirmed: true,
      exposure_start: null,
      state: "CA",
      tort_type: "Roundup",
      diagnosis_date: "2022-01-01",
      rejection_reason: null,
    };
    const res = detectRuinFlags(lead, mockTort);
    assert.ok(res.includes("exposure_missing"));
  });
});

test("detectMissingFields", async (t) => {
  await t.test("identifies missing required fields", () => {
    const lead = {
      diagnosis: "",
      diagnosis_date: null,
      exposure_start: null,
      state: "CA",
      phone: null,
      email: null,
    };
    const res = detectMissingFields(lead, mockTort);
    assert.deepEqual(res, ["diagnosis", "diagnosis_date", "contact", "exposure_start"]);
  });
});

test("scoreLead", async (t) => {
  await t.test("scores valid convex lead correctly", () => {
    const lead = {
      diagnosis: "Non-Hodgkin Lymphoma Cancer",
      diagnosis_confirmed: true,
      exposure_start: "2020-01-01",
      exposure_end: "2021-01-01",
      state: "CA",
      tort_type: "Roundup",
      diagnosis_date: new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString().split("T")[0],
      date_of_birth: "1980-01-01",
      rejection_reason: null,
      source: "Google Ads",
      phone: "5551234567",
      email: "test@example.com",
    };
    const res = scoreLead(lead, mockTort, mockSource, mockSettings);
    assert.equal(res.classification, "convex");
    assert.equal(res.action, "execute");
    assert.equal(res.ruin_flags.length, 0);
    assert.equal(res.contradictions.length, 0);
  });
});

test("buildPortfolio", async (t) => {
  await t.test("aggregates portfolio data correctly", () => {
    const leadsByTort = new Map([
      [
        "roundup",
        {
          lead_count: 10,
          total_spend: 2500,
          qualified: 6,
          retained: 4,
          ruin_flag_count: 1,
          convex_count: 8,
          concave_count: 1,
        },
      ],
    ]);
    const torts = new Map([["roundup", mockTort]]);
    const summary = buildPortfolio(leadsByTort, torts, mockSettings);
    assert.equal(summary.tort_count, 1);
    assert.equal(summary.total_spend_usd, 2500);
    assert.equal(summary.convex_count, 1);
  });
});
