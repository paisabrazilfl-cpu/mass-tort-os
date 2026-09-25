import { matchTaxonomyToDiagnosis } from "../taxonomy-engine";

const samples = [
  { spec: "Oncology Specialist", diag: "lung cancer", code: "207RH0003X" },
  { spec: "Pediatric Care", diag: "carcinoma", code: undefined },
  { spec: "General Practitioner", diag: "parkinsons", code: undefined },
  { spec: "Dermatologist", diag: "melanoma", code: undefined },
  { spec: "Orthopedic Surgeon", diag: "metallosis", code: undefined },
  { spec: "Dentist", diag: "unknown condition", code: undefined },
];

const iterations = 100000;

console.log(`Running taxonomy-engine benchmark with ${iterations} iterations across ${samples.length} sample inputs...`);

const start = performance.now();
for (let i = 0; i < iterations; i++) {
  for (let j = 0; j < samples.length; j++) {
    const s = samples[j];
    matchTaxonomyToDiagnosis(s.spec, s.diag, s.code);
  }
}
const end = performance.now();
const totalMs = end - start;
const totalCalls = iterations * samples.length;

console.log(`Total time: ${totalMs.toFixed(4)}ms`);
console.log(`Average per call: ${(totalMs / totalCalls).toFixed(6)}ms`);
console.log(`Calls per sec: ${(totalCalls / (totalMs / 1000)).toFixed(0)}`);
