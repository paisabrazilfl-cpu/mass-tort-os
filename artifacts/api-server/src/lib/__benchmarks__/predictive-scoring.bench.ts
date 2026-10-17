import { performance } from "node:perf_hooks";
import { scoreLeadRecord, type LeadScoringInput } from "../predictive-scoring";

function runBenchmark() {
  const mockLeads: LeadScoringInput[] = Array.from({ length: 100 }, (_, i) => ({
    id: i + 1,
    status: i % 2 === 0 ? "signed" : "new",
    tort_type: i % 3 === 0 ? "roundup" : "camp_lejeune",
    fraud_score: (i * 7) % 100,
    npi_verified: i % 2 === 0,
    diagnosis_confirmed: i % 3 !== 0,
    was_at_location: i % 4 !== 0,
    email: `lead${i}@example.com`,
    phone_primary: `555000${i.toString().padStart(4, "0")}`,
    street_address: `${i} Market St`,
    ad_spend: (i * 12.5).toString(),
    source: i % 2 === 0 ? "facebook" : "google",
  }));

  const ITERATIONS = 10000; // 1,000,000 total lead scoring operations
  const start = performance.now();

  for (let iter = 0; iter < ITERATIONS; iter++) {
    for (let i = 0; i < mockLeads.length; i++) {
      scoreLeadRecord(mockLeads[i]!);
    }
  }

  const end = performance.now();
  const totalMs = end - start;
  const totalOps = mockLeads.length * ITERATIONS;
  const msPerScoredLead = totalMs / totalOps;

  console.log(`[Predictive Scoring Benchmark]`);
  console.log(`Total Leads Scored: ${totalOps.toLocaleString()}`);
  console.log(`Total Duration: ${totalMs.toFixed(2)} ms`);
  console.log(`Latency per lead: ${(msPerScoredLead * 1000).toFixed(4)} µs (${msPerScoredLead.toFixed(6)} ms)`);
  console.log(`Throughput: ${Math.round(totalOps / (totalMs / 1000)).toLocaleString()} ops/sec`);
}

runBenchmark();
