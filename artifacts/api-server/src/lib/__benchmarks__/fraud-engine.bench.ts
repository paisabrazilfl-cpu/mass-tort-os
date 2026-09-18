import { runFraudDetection } from "../fraud-engine";

const benchmarkSamples = [
  // Sample 1: Valid clean lead
  {
    lead_data: {
      date_of_birth: "1975-06-15",
      diagnosis_date: "2021-03-20",
      exposure_start: "1995-01-01",
      diagnosis: "Non-Hodgkin Lymphoma",
      physician_first_name: "Robert",
      physician_last_name: "Johnson",
      tort_type: "Roundup",
    },
    tort_validation: {
      valid: true,
      diagnosis_match: true,
      exposure_valid: true,
      errors: [],
      warnings: [],
      matched_category: "Cancer",
    },
    taxonomy_match: null,
    npi_found: true,
  },
  // Sample 2: Taxonomy mismatch & missing NPI
  {
    lead_data: {
      date_of_birth: "1960-11-02",
      diagnosis_date: "2019-08-10",
      exposure_start: "1980-05-01",
      diagnosis: "Parkinson's Disease",
      physician_first_name: "Alice",
      physician_last_name: "Williams",
      tort_type: "Paraquat",
    },
    tort_validation: {
      valid: false,
      diagnosis_match: true,
      exposure_valid: false,
      errors: ["NO_EXPOSURE"],
      warnings: [],
      matched_category: "Neurological",
    },
    taxonomy_match: {
      matched: false,
      physician_specialty: "Pediatrics",
      diagnosis_category: "Neurology",
      confidence: 0.2,
      fraud_indicators: ["PEDIATRIC_PHYSICIAN_ADULT_CONDITION", "SPECIALTY_OUTSIDE_SCOPE"],
    },
    npi_found: false,
  },
  // Sample 3: Child under 5 with mesothelioma
  {
    lead_data: {
      date_of_birth: "2021-02-10",
      diagnosis_date: "2023-05-01",
      diagnosis: "Mesothelioma",
      tort_type: "Asbestos",
    },
    tort_validation: {
      valid: true,
      diagnosis_match: true,
      exposure_valid: true,
      errors: [],
      warnings: [],
      matched_category: "Mesothelioma",
    },
    taxonomy_match: null,
    npi_found: true,
  },
  // Sample 4: Invalid timeline / exposure before birth
  {
    lead_data: {
      date_of_birth: "1990-04-01",
      diagnosis_date: "1985-01-01",
      exposure_start: "1980-01-01",
      diagnosis: "Bladder Cancer",
      tort_type: "Camp Lejeune",
    },
    tort_validation: {
      valid: false,
      diagnosis_match: false,
      exposure_valid: false,
      errors: ["EXPOSURE_OUTSIDE_1953_1987"],
      warnings: [],
      matched_category: null,
    },
    taxonomy_match: null,
    npi_found: true,
  },
];

function runBenchmark() {
  const iterations = 100_000;
  const sampleCount = benchmarkSamples.length;

  // Warmup
  for (let i = 0; i < 5_000; i++) {
    runFraudDetection(benchmarkSamples[i % sampleCount]!);
  }

  const start = process.hrtime.bigint();
  for (let i = 0; i < iterations; i++) {
    runFraudDetection(benchmarkSamples[i % sampleCount]!);
  }
  const end = process.hrtime.bigint();

  const totalNs = Number(end - start);
  const totalMs = totalNs / 1_000_000;
  const nsPerOp = totalNs / iterations;
  const msPerOp = totalMs / iterations;

  console.log(`Fraud Detection Engine Benchmark:`);
  console.log(`Iterations: ${iterations}`);
  console.log(`Total time: ${totalMs.toFixed(2)} ms`);
  console.log(`Average time per operation: ${msPerOp.toFixed(6)} ms (${nsPerOp.toFixed(2)} ns)`);
}

runBenchmark();
