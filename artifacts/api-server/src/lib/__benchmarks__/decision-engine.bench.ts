import { scoreLead, detectContradictions, detectRuinFlags, detectMissingFields, buildPortfolio, TortInputs, SourceInputs, EngineSettings } from "../decision-engine";

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

const sampleLead = {
  diagnosis: "Non-Hodgkin Lymphoma",
  diagnosis_confirmed: true,
  exposure_start: "2015-05-10",
  exposure_end: "2020-08-15",
  state: "CA",
  tort_type: "roundup",
  diagnosis_date: "2022-01-15",
  date_of_birth: "1970-03-22",
  rejection_reason: null,
  source: "Meta Ads LeadGen",
  phone: "555-123-4567",
  email: "john.doe@example.com",
};

const iterations = 100000;

console.log(`Running Decision Engine benchmarks with ${iterations} iterations...`);

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
