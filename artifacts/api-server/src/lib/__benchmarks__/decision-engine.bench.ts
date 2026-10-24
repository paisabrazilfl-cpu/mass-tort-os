import {
  scoreLead,
  detectContradictions,
  detectRuinFlags,
  detectMissingFields,
  buildPortfolio,
  type TortInputs,
  type SourceInputs,
  type EngineSettings,
} from "../decision-engine";

const sampleLead = {
  id: 1,
  diagnosis: "Non-Hodgkin Lymphoma (Cancer)",
  diagnosis_confirmed: true,
  exposure_start: "2015-05-01",
  exposure_end: "2020-08-15",
  state: "CA",
  tort_type: "roundup",
  diagnosis_date: "2021-03-10",
  date_of_birth: "1975-11-20",
  rejection_reason: null,
  source: "Google Ads",
  phone: "555-0199",
  email: "test@example.com",
} as any;

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

const leadsByTort = new Map([
  [
    "roundup",
    {
      lead_count: 500,
      total_spend: 125000,
      qualified: 300,
      retained: 175,
      ruin_flag_count: 20,
      convex_count: 350,
      concave_count: 50,
    },
  ],
  [
    "camp-lejeune",
    {
      lead_count: 300,
      total_spend: 90000,
      qualified: 180,
      retained: 90,
      ruin_flag_count: 15,
      convex_count: 200,
      concave_count: 40,
    },
  ],
]);

const tortsMap = new Map([
  ["roundup", sampleTort],
  [
    "camp-lejeune",
    {
      ...sampleTort,
      id: "camp-lejeune",
      label: "Camp Lejeune Water Contamination",
    },
  ],
]);

const iterations = 200000;

console.log(`Running decision-engine benchmarks with ${iterations} iterations...`);

function benchmark(name: string, fn: () => void) {
  const start = performance.now();
  for (let i = 0; i < iterations; i++) {
    fn();
  }
  const end = performance.now();
  console.log(`${name}: ${(end - start).toFixed(4)}ms (total), ${((end - start) / iterations).toFixed(6)}ms (avg)`);
}

benchmark("detectContradictions", () => {
  detectContradictions(sampleLead);
});

benchmark("detectRuinFlags", () => {
  detectRuinFlags(sampleLead, sampleTort);
});

benchmark("detectMissingFields", () => {
  detectMissingFields(sampleLead, sampleTort);
});

benchmark("scoreLead", () => {
  scoreLead(sampleLead, sampleTort, sampleSource, sampleSettings);
});

benchmark("buildPortfolio", () => {
  buildPortfolio(leadsByTort, tortsMap, sampleSettings);
});
