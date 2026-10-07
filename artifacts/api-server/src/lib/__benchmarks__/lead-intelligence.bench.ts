import {
  computeCompletionScore,
  computeReliabilityScore,
  computeTruthfulnessScore,
} from "../lead-intelligence";

const sampleLeads = [
  {
    lead: {
      first_name: "Jane",
      last_name: "Doe",
      date_of_birth: "1980-01-01",
      phone_primary: "5551234567",
      email: "jane@example.com",
      street_address: "123 Main St",
      city: "Austin",
      state: "TX",
      zip: "78701",
      last_4_ssn: "1234",
      tort_type: "Roundup",
      diagnosis: "Non-Hodgkin Lymphoma",
      diagnosis_date: "2020-05-15",
      physician_first_name: "John",
      physician_last_name: "Smith",
      physician_full_address: "456 Medical Pkwy, Austin, TX",
      physician_contact_info: "555-999-8888",
      hospital_name: "Austin General Hospital",
      hospital_fax: "555-999-8889",
      hospital_contact_info: "555-999-8880",
      medications: "Med A, Med B",
      exposure_start: "2010-01-01",
      exposure_end: "2019-12-31",
      location_name: "Farm Site A",
      npi_number: "1234567890",
      source: "Web Form",
      law_firm: "Law Office of Test",
      trustedform_cert_url: "https://cert.trustedform.com/test",
      diagnosis_confirmed: true,
      was_at_location: true,
      tcpa_consent: true,
      npi_verified: true,
      email_validation_status: "valid",
      address_validation_status: "valid",
      background_check_status: "clean",
      fraud_score: 5,
      fraud_status: "ACCEPTED",
      fraud_indicators: JSON.stringify(["ip_mismatch", "proxy_detected"]),
      status: "qualified",
    },
    documents: [
      { id: 1, name: "Medical Record.pdf", signed: true },
      { id: 2, name: "Retainer.pdf", signed: true },
    ],
  },
  {
    lead: {
      first_name: "John",
      last_name: "",
      email: "invalid-email",
      tort_type: "Camp Lejeune",
      diagnosis_confirmed: false,
      was_at_location: false,
      tcpa_consent: false,
      email_validation_status: "invalid",
      address_validation_status: "invalid",
      background_check_status: "flagged",
      fraud_score: 85,
      fraud_status: "REJECTED",
      fraud_indicators: "some raw indicator string",
      status: "review_required",
    },
    documents: [],
  },
];

async function runBenchmark() {
  // Export functions temporarily to benchmark
  const ITERATIONS = 500_000;
  console.log(`Running Lead Intelligence Scoring Benchmark (${ITERATIONS.toLocaleString()} iterations)...`);

  const start = performance.now();
  for (let i = 0; i < ITERATIONS; i++) {
    const sample = sampleLeads[i % sampleLeads.length];
    computeCompletionScore(sample.lead);
    computeReliabilityScore(sample.lead, sample.documents);
    computeTruthfulnessScore(sample.lead);
  }
  const end = performance.now();

  const totalTimeMs = end - start;
  const timePerOpUs = (totalTimeMs / (ITERATIONS * sampleLeads.length)) * 1000;
  const opsPerSec = Math.round((ITERATIONS * sampleLeads.length) / (totalTimeMs / 1000));

  console.log(`Total time: ${totalTimeMs.toFixed(2)} ms`);
  console.log(`Avg time per lead score computation: ${timePerOpUs.toFixed(4)} µs (${(timePerOpUs / 1000).toFixed(6)} ms)`);
  console.log(`Throughput: ${opsPerSec.toLocaleString()} ops/sec`);
}

runBenchmark().catch(console.error);
