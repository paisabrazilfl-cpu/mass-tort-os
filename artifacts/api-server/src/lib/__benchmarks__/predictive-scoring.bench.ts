import { performance } from "node:perf_hooks";
import { computePredictiveScoreForLead, PredictiveLeadInput } from "../predictive-scoring";

const sampleLeads: PredictiveLeadInput[] = [
  {
    id: 101,
    status: "new",
    tort_type: "roundup",
    fraud_score: 15,
    npi_verified: true,
    diagnosis_confirmed: true,
    was_at_location: true,
    email: "john@example.com",
    phone: "555-123-4567",
    street_address: "123 Main St",
    ad_spend: 150,
    source: "google_ads",
  },
  {
    id: 102,
    status: "new",
    tort_type: "camp_lejeune",
    fraud_score: 55,
    npi_verified: false,
    diagnosis_confirmed: true,
    was_at_location: false,
    email: "jane@example.com",
    phone: null,
    street_address: "456 Oak Rd",
    ad_spend: "0",
    source: "facebook",
  },
  {
    id: 103,
    status: "new",
    tort_type: "hair_relaxer",
    fraud_score: 85,
    npi_verified: false,
    diagnosis_confirmed: false,
    was_at_location: false,
    email: null,
    phone: null,
    street_address: null,
    ad_spend: 0,
    source: "unknown",
  },
];

function runBenchmark(iterations = 100_000) {
  console.log(`Running predictive lead scoring benchmark (${iterations} iterations)...`);

  // Warm up
  for (let i = 0; i < 1_000; i++) {
    computePredictiveScoreForLead(sampleLeads[i % sampleLeads.length]!);
  }

  const start = performance.now();
  for (let i = 0; i < iterations; i++) {
    computePredictiveScoreForLead(sampleLeads[i % sampleLeads.length]!);
  }
  const end = performance.now();

  const totalMs = end - start;
  const avgMs = totalMs / iterations;
  const opsPerSec = Math.round((iterations / totalMs) * 1000);

  console.log(`Benchmark Results:`);
  console.log(`  Total time: ${totalMs.toFixed(2)} ms`);
  console.log(`  Average latency: ${avgMs.toFixed(6)} ms / call`);
  console.log(`  Throughput: ${opsPerSec.toLocaleString()} ops / sec`);
}

runBenchmark();
