import { matchTaxonomyToDiagnosis } from "../taxonomy-engine";

const SAMPLE_INPUTS = [
  { spec: "Oncology", diag: "Non-Hodgkin Lymphoma", code: "207RH0003X" },
  { spec: "Internal Medicine", diag: "Parkinson's Disease", code: undefined },
  { spec: "Pediatrics", diag: "Mesothelioma", code: undefined },
  { spec: "Dermatology", diag: "Lung Cancer", code: undefined },
  { spec: "Dentistry", diag: "Bladder Cancer", code: undefined },
  { spec: "Gastroenterology", diag: "Gastroparesis", code: undefined },
  { spec: "Orthopedic Surgery", diag: "Hernia mesh migration", code: undefined },
  { spec: "Psychiatry", diag: "PTSD and depression", code: undefined },
];

function runBenchmark() {
  const iterations = 100_000;

  // Warmup
  for (let i = 0; i < 1_000; i++) {
    const sample = SAMPLE_INPUTS[i % SAMPLE_INPUTS.length];
    matchTaxonomyToDiagnosis(sample.spec, sample.diag, sample.code);
  }

  const start = performance.now();
  for (let i = 0; i < iterations; i++) {
    const sample = SAMPLE_INPUTS[i % SAMPLE_INPUTS.length];
    matchTaxonomyToDiagnosis(sample.spec, sample.diag, sample.code);
  }
  const end = performance.now();
  const durationMs = end - start;

  console.log(`[taxonomy-engine] ${iterations} iterations executed in ${durationMs.toFixed(2)} ms`);
  console.log(`Average latency per match: ${(durationMs / iterations).toFixed(5)} ms`);
}

runBenchmark();
