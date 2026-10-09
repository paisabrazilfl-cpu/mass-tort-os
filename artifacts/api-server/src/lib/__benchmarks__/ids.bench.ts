import { performance } from "perf_hooks";
import { deepScan, scanValue } from "../ids";

const samplePayloads = [
  {
    name: "John Doe",
    email: "john.doe@example.com",
    phone: "555-0199",
    state: "CA",
    zip: "90210",
    claim: {
      tort_id: "camp-lejeune",
      injury_date: "2021-05-10",
      exposure_years: 5,
      medical_records_attached: true,
      notes: "Client lived on base from 1980 to 1985.",
    },
    metadata: {
      source: "web_form",
      campaign_id: 1042,
      utm_medium: "cpc",
      tags: ["priority", "verified"],
    },
  },
  {
    search: "John Smith",
    page: "1",
    limit: "25",
    sort: "created_at",
    order: "desc",
    filter: {
      status: "pending",
      category: "medical_injury",
    },
  },
  {
    short_string: "a",
    num: 123,
    bool: true,
    nullVal: null,
    empty: "",
  },
  {
    nested: {
      deep: {
        deeper: {
          array: ["one", "two", "three", "four", "five"],
        },
      },
    },
  },
];

const threatPayload = {
  user: "admin",
  comment: "<script>alert('xss')</script>",
};

function runBenchmark() {
  const iterations = 100_000;

  // Warmup
  for (let i = 0; i < 1_000; i++) {
    for (const payload of samplePayloads) {
      deepScan(payload);
    }
    deepScan(threatPayload);
  }

  const start = performance.now();
  for (let i = 0; i < iterations; i++) {
    for (const payload of samplePayloads) {
      deepScan(payload);
    }
  }
  const duration = performance.now() - start;

  console.log(`Total duration for ${iterations * samplePayloads.length} deepScan operations: ${duration.toFixed(2)} ms`);
  console.log(`Average latency per scan: ${(duration / (iterations * samplePayloads.length)).toFixed(6)} ms`);
  console.log(`Throughput: ${Math.round((iterations * samplePayloads.length) / (duration / 1000))} ops/sec`);
}

runBenchmark();
