process.env["DATABASE_URL"] = process.env["DATABASE_URL"] || "postgres://localhost:5432/test";

import { checkLogicalConflicts, checkDataIntegrity, type ConflictCheckContext } from "../conflict-engine";

const sampleContexts: ConflictCheckContext[] = [
  {
    entity_type: "lead",
    entity_id: "lead_1",
    source_module: "web_form",
    lead_data: {
      name: "John Doe",
      tort_type: "Camp Lejeune",
      diagnosis_type: "Bladder Cancer",
      location: "Jacksonville, NC",
      exposure_start: "1980-01-01",
      exposure_end: "1985-12-31",
      email: "john.doe@example.com",
      phone: "9195551234",
    },
  },
  {
    entity_type: "lead",
    entity_id: "lead_2",
    source_module: "web_form",
    lead_data: {
      name: "Jane Smith",
      tort_type: "Roundup",
      diagnosis_type: "Non-Hodgkin Lymphoma",
      location_name: "Paris, France",
      exposure_start: "2010-05-01",
      exposure_end: "2015-05-01",
      email: "jane.smith@example.com",
      phone: "5551234567",
    },
  },
  {
    entity_type: "lead",
    entity_id: "lead_3",
    source_module: "lead_import",
    lead_data: {
      name: "aaaa",
      tort_type: "12345",
      diagnosis_type: "unknown condition",
      location: "TX",
      exposure_start: "2020-01-01",
      exposure_end: "2010-01-01",
      email: "invalid-email",
      phone: "123",
    },
  },
  {
    entity_type: "lead",
    entity_id: "lead_4",
    source_module: "lead_import",
    lead_data: {
      tort_type: "",
      location: "USA",
      email: "",
    },
  },
];

const iterations = 200_000;

console.log(`Running conflict-engine benchmark with ${iterations} iterations across 4 contexts...`);

// Warmup
for (let i = 0; i < 5_000; i++) {
  const ctx = sampleContexts[i % sampleContexts.length]!;
  checkLogicalConflicts(ctx);
  checkDataIntegrity(ctx);
}

const start = performance.now();
for (let i = 0; i < iterations; i++) {
  const ctx = sampleContexts[i % sampleContexts.length]!;
  checkLogicalConflicts(ctx);
  checkDataIntegrity(ctx);
}
const end = performance.now();
const totalMs = end - start;
const avgMs = totalMs / iterations;
const opsPerSec = Math.round((iterations / totalMs) * 1000);

console.log(`Total time: ${totalMs.toFixed(3)}ms`);
console.log(`Average per check: ${(avgMs * 1000).toFixed(3)}µs (${avgMs.toFixed(6)}ms)`);
console.log(`Throughput: ${opsPerSec.toLocaleString()} ops/sec`);
