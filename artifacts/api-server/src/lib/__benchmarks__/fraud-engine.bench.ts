import { runFraudDetection } from "../fraud-engine";

function bench() {
  const sampleContext = {
    lead_data: {
      date_of_birth: "1980-05-12",
      diagnosis_date: "2020-03-15",
      exposure_start: "1985-01-01",
      diagnosis: "Mesothelioma",
      tort_type: "Roundup",
      physician_first_name: "John",
      physician_last_name: "Doe",
    },
    tort_validation: {
      diagnosis_match: true,
      errors: ["NO_EXPOSURE"],
    } as any,
    taxonomy_match: {
      fraud_indicators: ["TAXONOMY_MISMATCH", "SPECIALTY_OUTSIDE_SCOPE"],
      physician_specialty: "Dermatology",
      diagnosis_category: "Oncology",
    } as any,
    npi_found: false,
  };

  const iterations = 200000;
  // Warmup
  for (let i = 0; i < 1000; i++) {
    runFraudDetection(sampleContext);
  }

  const start = process.hrtime.bigint();
  for (let i = 0; i < iterations; i++) {
    runFraudDetection(sampleContext);
  }
  const end = process.hrtime.bigint();

  const totalNs = Number(end - start);
  const avgNs = totalNs / iterations;
  const avgMs = avgNs / 1000000;
  const opsPerSec = (iterations / totalNs) * 1e9;

  console.log(`[BENCHMARK] runFraudDetection:`);
  console.log(`  Total time: ${(totalNs / 1e6).toFixed(2)} ms`);
  console.log(`  Avg latency: ${avgNs.toFixed(2)} ns (${avgMs.toFixed(6)} ms)`);
  console.log(`  Throughput: ${opsPerSec.toFixed(0)} ops/sec`);
}

bench();
