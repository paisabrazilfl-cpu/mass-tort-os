import { checkLogicalConflicts, checkDataIntegrity, checkRuleOverrideConflict, ConflictCheckContext } from "../conflict-engine";

const validCtx: ConflictCheckContext = {
  entity_type: "lead",
  entity_id: "101",
  source_module: "benchmark",
  lead_data: {
    name: "Jane Doe",
    location_name: "Houston, TX, USA",
    tort_type: "Camp Lejeune",
    diagnosis_type: "Non-Hodgkin Lymphoma",
    exposure_start: "1982-05-10",
    exposure_end: "1987-11-20",
    email: "jane.doe@example.com",
    phone: "(713) 555-0199",
  },
};

const invalidCtx: ConflictCheckContext = {
  entity_type: "lead",
  entity_id: "102",
  source_module: "benchmark",
  lead_data: {
    name: "XXXXXX",
    location: "London, UK",
    tort_type: "Roundup",
    diagnosis_type: "Flu",
    exposure_start: "2021-01-01",
    exposure_end: "2015-01-01",
    email: "invalid-email-address",
    phone: "12345",
  },
};

const buyerCriteria = {
  allowed_locations: ["TX", "CA", "FL", "NY"],
  min_age: 21,
  required_conditions: ["cancer", "leukemia"],
};

const globalRules = {
  allowed_locations: ["TX", "CA", "FL"],
  min_age: 18,
  required_conditions: ["cancer"],
};

const ITERATIONS = 100_000;

console.log(`Running conflict-engine benchmark (${ITERATIONS.toLocaleString()} iterations)...`);

// Warmup
for (let i = 0; i < 1_000; i++) {
  checkLogicalConflicts(validCtx);
  checkDataIntegrity(validCtx);
  checkRuleOverrideConflict(buyerCriteria, globalRules, validCtx);
}

const start = performance.now();

for (let i = 0; i < ITERATIONS; i++) {
  checkLogicalConflicts(validCtx);
  checkLogicalConflicts(invalidCtx);
  checkDataIntegrity(validCtx);
  checkDataIntegrity(invalidCtx);
  checkRuleOverrideConflict(buyerCriteria, globalRules, validCtx);
}

const end = performance.now();
const elapsedMs = end - start;
const msPerCall = elapsedMs / (ITERATIONS * 5);

console.log(`Total time for ${ITERATIONS * 5} calls: ${elapsedMs.toFixed(2)} ms`);
console.log(`Average time per check call: ${(msPerCall * 1000).toFixed(4)} μs (${msPerCall.toFixed(6)} ms)`);
