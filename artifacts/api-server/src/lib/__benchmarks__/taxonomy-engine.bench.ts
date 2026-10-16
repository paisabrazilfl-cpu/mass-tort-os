import { matchTaxonomyToDiagnosis } from "../taxonomy-engine";

const SAMPLE_CASES = [
  { spec: "Oncology Specialist", diag: "lung cancer", npi: "207RH0003X" },
  { spec: "General Practice Physician", diag: "parkinson disease" },
  { spec: "Pediatric Care", diag: "mesothelioma" },
  { spec: "Dermatologist", diag: "breast cancer" },
  { spec: "Orthodontist", diag: "ovarian cancer" },
  { spec: "Urology Clinic", diag: "kidney cancer" },
  { spec: "Neurologist", diag: "traumatic brain injury" },
  { spec: "Unknown Specialty", diag: "some random non-existent diagnosis" },
  { spec: "Pulmonology Specialist", diag: "asbestosis" },
  { spec: "Internal Medicine", diag: "gastroparesis" },
];

const ITERATIONS = 200000;

console.time("matchTaxonomyToDiagnosis");
for (let i = 0; i < ITERATIONS; i++) {
  const sample = SAMPLE_CASES[i % SAMPLE_CASES.length]!;
  matchTaxonomyToDiagnosis(sample.spec, sample.diag, sample.npi);
}
console.timeEnd("matchTaxonomyToDiagnosis");
