import { performance } from "perf_hooks";
import { sanitizeHubResultForPersistence } from "../bg-hub/snapshot-sanitizer.js";
import type { BackgroundHubResult } from "../bg-hub/types.js";

const sampleHubResult: BackgroundHubResult = {
  lead_id: 12345,
  overall_score: 85,
  final_status: "PASS",
  summary: {
    passed_lanes: ["email", "phone", "name"],
    failed_lanes: [],
    warning_lanes: [],
  },
  results: [
    {
      lane: "email",
      status: "PASS",
      score: 100,
      flags: [],
      notes: [],
      sources: ["zerobounce"],
      checked_at: "2026-04-29T12:00:00.000Z",
      raw: {
        email: "alicia.rodriguezunique@piltest.example",
        user_email: "alicia.rodriguezunique@piltest.example",
        suggestion: "alicia.rodriguezunique@piltest.example",
        status: "valid",
        sub_status: "",
        free_email: false,
        did_you_mean: null,
        account: "alicia.rodriguezunique",
        domain: "piltest.example",
        domain_age_days: 1200,
        smtp_provider: "google",
        mx_found: "true",
        mx_record: "aspmx.l.google.com",
        firstname: "Alicia",
        lastname: "RodriguezTestUnique",
        gender: "female",
        country: "United States",
        region: "Texas",
        city: "Austin",
        zipcode: "78701",
        processed_at: "2026-04-29T12:00:00.000Z",
      },
    },
    {
      lane: "phone",
      status: "PASS",
      score: 90,
      flags: [],
      notes: [],
      sources: ["telnyx", "twiliolookup"],
      checked_at: "2026-04-29T12:00:00.000Z",
      raw: {
        phone: "5125550173",
        phone_primary: "5125550173",
        input: "+15125550173",
        normalized: "5125550173",
        carrier: "AT&T Mobility",
        line_type: "mobile",
        country_code: "US",
        national_format: "(512) 555-0173",
        valid: true,
        caller_name: {
          name: "Alicia RodriguezTestUnique",
          type: "CONSUMER",
        },
      },
    },
    {
      lane: "courtlistener_attorney",
      status: "PASS",
      score: 100,
      flags: [],
      notes: [],
      sources: ["courtlistener"],
      checked_at: "2026-04-29T12:00:00.000Z",
      raw: {
        searched_name: "Alicia RodriguezTestUnique",
        dob: "1985-06-15",
        records: [
          {
            id: 101,
            defendant_name: "Alicia RodriguezTestUnique",
            court: "cand",
            docket_number: "3:24-cv-01234",
          },
          {
            id: 102,
            defendant_name: "Alicia RodriguezTestUnique",
            court: "txnd",
            docket_number: "1:23-cv-05678",
          },
        ],
        summary: "No disciplinary actions found for searched name.",
      },
    },
  ],
};

export function runSnapshotSanitizerBenchmark(iterations = 100_000) {
  for (let i = 0; i < 1_000; i++) {
    sanitizeHubResultForPersistence(sampleHubResult);
  }

  const start = performance.now();
  for (let i = 0; i < iterations; i++) {
    sanitizeHubResultForPersistence(sampleHubResult);
  }
  const duration = performance.now() - start;

  console.log(`sanitizeHubResultForPersistence (${iterations} ops): ${duration.toFixed(2)} ms (${(duration / iterations).toFixed(6)} ms/op)`);
  return duration;
}

if (process.argv[1] && process.argv[1].endsWith("snapshot-sanitizer.bench.ts")) {
  runSnapshotSanitizerBenchmark();
}
