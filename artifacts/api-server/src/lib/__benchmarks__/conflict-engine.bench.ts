import { checkLogicalConflicts, checkDataIntegrity, ConflictCheckContext } from "../conflict-engine";

const sampleContexts: ConflictCheckContext[] = [
  {
    entity_type: "lead",
    entity_id: "lead_101",
    source_module: "web_form",
    lead_data: {
      name: "John Doe",
      tort_type: "Camp Lejeune",
      email: "john.doe@example.com",
      phone: "(512) 555-0199",
      location: "Austin, TX, USA",
      diagnosis_type: "Kidney Disease from water exposure",
      exposure_start: "1980-01-01",
      exposure_end: "1987-12-31",
    },
  },
  {
    entity_type: "lead",
    entity_id: "lead_102",
    source_module: "api_import",
    lead_data: {
      name: "Jane Smith",
      tort_type: "Roundup",
      email: "jane.smith@example.org",
      phone: "+15125550188",
      location_name: "London, UK", // Outside US
      diagnosis_type: "Non-Hodgkin Lymphoma",
      exposure_start: "2015-05-10",
      exposure_end: "2010-01-01", // Start after end conflict
    },
  },
  {
    entity_type: "lead",
    entity_id: "lead_103",
    source_module: "form_engine",
    lead_data: {
      name: "A", // too short name
      tort_type: "123", // garbage tort
      email: "invalid-email",
      phone: "123", // invalid phone
    },
  },
];

const iterations = 200_000;
console.log(`Running conflict-engine benchmark with ${iterations} iterations...`);

const start = performance.now();
for (let i = 0; i < iterations; i++) {
  const ctx = sampleContexts[i % sampleContexts.length]!;
  checkLogicalConflicts(ctx);
  checkDataIntegrity(ctx);
}
const elapsed = performance.now() - start;

console.log(`Total time: ${elapsed.toFixed(2)}ms`);
console.log(`Per check: ${(elapsed / (iterations * 2)).toFixed(6)}ms`);
