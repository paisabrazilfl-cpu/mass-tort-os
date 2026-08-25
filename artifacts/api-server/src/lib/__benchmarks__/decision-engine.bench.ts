import { scoreLead, detectContradictions, detectRuinFlags, detectMissingFields, TortInputs, SourceInputs, EngineSettings } from "../decision-engine";

const SAMPLE_TORT: TortInputs = {
  id: "roundup",
  label: "Roundup",
  avg_settlement_low: 50000,
  avg_settlement_high: 150000,
  expected_duration_months: 24,
  mdl_status: "active",
  sol_months: 36,
  rejection_conditions: [],
  required_exposure: true,
  valid_diagnoses: ["non-hodgkin lymphoma", "nhl", "dlbcl", "leukemia"],
};

const SAMPLE_SOURCE: SourceInputs = {
  name: "Google Ads",
  cost_per_lead: 150,
  historical_qualified_rate: 0.6,
  historical_retained_rate: 0.35,
};

const SAMPLE_SETTINGS: EngineSettings = {
  default_attorney_hourly_cost: 250,
  default_hours_per_lead: 0.5,
  convex_ratio_threshold: 10.0,
  concave_ratio_threshold: 2.0,
  concentration_warning_pct: 35.0,
  ruin_auto_flag: true,
};

const SAMPLE_LEADS = [
  {
    diagnosis: "Non-Hodgkin Lymphoma",
    diagnosis_confirmed: true,
    exposure_start: "2015-01-01",
    exposure_end: "2020-01-01",
    state: "CA",
    tort_type: "roundup",
    diagnosis_date: "2023-01-01",
    date_of_birth: "1970-01-01",
    rejection_reason: null,
    source: "Google Ads",
    phone: "555-123-4567",
    email: "john@example.com",
  },
  {
    diagnosis: "Kidney Disease",
    diagnosis_confirmed: false,
    exposure_start: "2018-01-01",
    exposure_end: "2019-01-01",
    state: "NY",
    tort_type: "roundup",
    diagnosis_date: "2022-05-15",
    date_of_birth: "1985-03-20",
    rejection_reason: null,
    source: "Facebook Ads",
    phone: "555-987-6543",
    email: null,
  },
  {
    diagnosis: "Non-Hodgkin Lymphoma",
    diagnosis_confirmed: true,
    exposure_start: "2023-01-01",
    exposure_end: "2020-01-01", // contradiction!
    state: "TX",
    tort_type: "roundup",
    diagnosis_date: "2021-01-01",
    date_of_birth: "1990-01-01",
    rejection_reason: null,
    source: "Google Ads",
    phone: null,
    email: null,
  },
];

function runBenchmark() {
  const iterations = 100_000;

  // Warmup
  for (let i = 0; i < 1_000; i++) {
    const lead = SAMPLE_LEADS[i % SAMPLE_LEADS.length];
    scoreLead(lead, SAMPLE_TORT, SAMPLE_SOURCE, SAMPLE_SETTINGS);
  }

  const start = performance.now();
  for (let i = 0; i < iterations; i++) {
    const lead = SAMPLE_LEADS[i % SAMPLE_LEADS.length];
    scoreLead(lead, SAMPLE_TORT, SAMPLE_SOURCE, SAMPLE_SETTINGS);
  }
  const end = performance.now();
  const durationMs = end - start;

  console.log(`[decision-engine] ${iterations} iterations executed in ${durationMs.toFixed(2)} ms`);
  console.log(`Average latency per lead score: ${(durationMs / iterations).toFixed(5)} ms`);
}

runBenchmark();
