import { checkLogicalConflicts, checkDataIntegrity, runFullConflictCheck, ConflictCheckContext } from "../conflict-engine";

const SAMPLE_CONTEXTS: ConflictCheckContext[] = [
  {
    entity_type: "lead",
    entity_id: "lead_123",
    source_module: "intake",
    lead_data: {
      name: "John Doe",
      email: "john.doe@example.com",
      phone: "555-123-4567",
      tort_type: "Camp Lejeune",
      diagnosis_type: "bladder cancer",
      location_name: "New York, NY, USA",
      exposure_start: "1975-01-01",
      exposure_end: "1980-01-01",
    },
  },
  {
    entity_type: "lead",
    entity_id: "lead_456",
    source_module: "intake",
    lead_data: {
      name: "Jane Smith",
      email: "jane.smith@example.com",
      phone: "555-987-6543",
      tort_type: "Roundup",
      diagnosis_type: "non-hodgkin lymphoma",
      location: "CA",
      exposure_start: "2010-05-01",
      exposure_end: "2015-05-01",
    },
  },
  {
    entity_type: "lead",
    entity_id: "lead_789",
    source_module: "intake",
    lead_data: {
      name: "Bob Johnson",
      email: "invalid-email",
      phone: "123",
      tort_type: "Unknown Tort",
      diagnosis_type: "fever",
      location: "London, UK",
      exposure_start: "2020-01-01",
      exposure_end: "2019-01-01",
    },
  },
];

function runBenchmark() {
  const iterations = 100_000;

  // Warmup
  for (let i = 0; i < 1_000; i++) {
    const ctx = SAMPLE_CONTEXTS[i % SAMPLE_CONTEXTS.length];
    checkLogicalConflicts(ctx);
    checkDataIntegrity(ctx);
  }

  const start = performance.now();
  for (let i = 0; i < iterations; i++) {
    const ctx = SAMPLE_CONTEXTS[i % SAMPLE_CONTEXTS.length];
    checkLogicalConflicts(ctx);
    checkDataIntegrity(ctx);
  }
  const end = performance.now();
  const durationMs = end - start;

  console.log(`[conflict-engine] ${iterations} iterations executed in ${durationMs.toFixed(2)} ms`);
  console.log(`Average latency per check: ${(durationMs / iterations).toFixed(5)} ms`);
}

runBenchmark();
