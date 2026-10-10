import { runFraudDetection } from "../fraud-engine";
import { TortValidationResult } from "../tort-engine";
import { TaxonomyMatchResult } from "../taxonomy-engine";

const mockTortValid: TortValidationResult = {
  valid: true,
  diagnosis_match: true,
  category: "Toxic Tort",
  errors: ["EXPOSURE_OUTSIDE_1953_1987"],
  required_evidence: [],
};

const mockTaxonomy: TaxonomyMatchResult = {
  match: true,
  physician_specialty: "Oncology",
  diagnosis_category: "Cancer",
  fraud_indicators: ["TAXONOMY_MISMATCH", "SPECIALTY_OUTSIDE_SCOPE"],
};

const mockContexts = [
  {
    lead_data: {
      date_of_birth: "1980-05-15",
      diagnosis_date: "2020-01-10",
      exposure_start: "1975-01-01", // before DOB!
      diagnosis: "Mesothelioma",
      physician_first_name: "John",
      physician_last_name: "Doe",
      tort_type: "Camp Lejeune",
    },
    tort_validation: mockTortValid,
    taxonomy_match: mockTaxonomy,
    npi_found: true,
  },
  {
    lead_data: {
      date_of_birth: "2018-01-01",
      diagnosis_date: "2020-06-01", // age < 5
      exposure_start: "2019-01-01",
      diagnosis: "Mesothelioma", // adult-only
      physician_first_name: "Jane",
      physician_last_name: "Smith",
      tort_type: "Roundup",
    },
    tort_validation: mockTortValid,
    taxonomy_match: mockTaxonomy,
    npi_found: false,
  },
  {
    lead_data: {
      date_of_birth: "1970-03-20",
      diagnosis_date: "2015-11-12",
      exposure_start: "1980-01-01",
      diagnosis: "Non-Hodgkin Lymphoma",
      physician_first_name: "Alice",
      physician_last_name: "Johnson",
      tort_type: "Roundup",
    },
    tort_validation: { valid: true, diagnosis_match: true, category: "Toxic Tort", errors: [], required_evidence: [] },
    taxonomy_match: null,
    npi_found: true,
  },
];

function benchmark() {
  const ITERATIONS = 300_000;
  console.log(`Running fraud-engine benchmark with ${ITERATIONS} iterations...`);

  // Warmup
  for (let i = 0; i < 1000; i++) {
    runFraudDetection(mockContexts[i % mockContexts.length]);
  }

  const start = performance.now();
  for (let i = 0; i < ITERATIONS; i++) {
    runFraudDetection(mockContexts[i % mockContexts.length]);
  }
  const duration = performance.now() - start;

  const avgMs = duration / ITERATIONS;
  const opsPerSec = (ITERATIONS / duration) * 1000;

  console.log(`Total time: ${duration.toFixed(2)} ms`);
  console.log(`Avg per call: ${avgMs.toFixed(6)} ms (${(avgMs * 1000).toFixed(2)} µs)`);
  console.log(`Ops/sec: ${Math.round(opsPerSec).toLocaleString()}`);
}

benchmark();
