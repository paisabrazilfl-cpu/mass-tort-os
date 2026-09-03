import { scoreLead, detectContradictions, detectRuinFlags, detectMissingFields, buildPortfolio } from "../decision-engine";
import type { Lead } from "@workspace/db";

const mockLead: Pick<
  Lead,
  | "diagnosis"
  | "diagnosis_confirmed"
  | "exposure_start"
  | "exposure_end"
  | "state"
  | "tort_type"
  | "diagnosis_date"
  | "date_of_birth"
  | "rejection_reason"
  | "source"
  | "phone"
  | "email"
> = {
  diagnosis: "Non-Hodgkin Lymphoma Cancer",
  diagnosis_confirmed: true,
  exposure_start: "2015-05-10",
  exposure_end: "2020-01-15",
  state: "CA",
  tort_type: "Roundup",
  diagnosis_date: "2021-08-20",
  date_of_birth: "1975-03-12",
  rejection_reason: null,
  source: "Google Ads",
  phone: "5551234567",
  email: "john.doe@example.com",
};

const mockTort = {
  id: "roundup",
  label: "Roundup",
  avg_settlement_low: 50000,
  avg_settlement_high: 150000,
  expected_duration_months: 24,
  mdl_status: "active_bellwether",
  sol_months: 36,
  rejection_conditions: [],
  required_exposure: true,
  valid_diagnoses: ["Non-Hodgkin Lymphoma", "NHL", "Chronic Lymphocytic Leukemia", "Multiple Myeloma"],
};

const mockSource = {
  name: "Google Ads",
  cost_per_lead: 250,
  historical_qualified_rate: 0.6,
  historical_retained_rate: 0.35,
};

const mockSettings = {
  default_attorney_hourly_cost: 350,
  default_hours_per_lead: 1.5,
  convex_ratio_threshold: 3.0,
  concave_ratio_threshold: 1.0,
  concentration_warning_pct: 30,
  ruin_auto_flag: true,
};

const iterations = 100000;

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
  detectContradictions(mockLead);
});

benchmark("detectRuinFlags", () => {
  detectRuinFlags(mockLead, mockTort);
});

benchmark("detectMissingFields", () => {
  detectMissingFields(mockLead, mockTort);
});

benchmark("scoreLead", () => {
  scoreLead(mockLead, mockTort, mockSource, mockSettings);
});
