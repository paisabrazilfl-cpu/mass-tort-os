import { validateTortClaim, getTortCategories } from "../tort-engine";

const SAMPLE_CLAIMS = [
  { tort_type: "Roundup", diagnosis: "Non-Hodgkin Lymphoma", exposure_start: "2015-05-01" },
  { tort_type: "roundup", diagnosis: "dlbcl", exposure_start: "2018-01-01" },
  { tort_type: "Camp Lejeune", diagnosis: "Kidney Cancer", exposure_start: "1975-06-15", location_name: "Base Camp" },
  { tort_type: "camp-lejeune", diagnosis: "Leukemia", exposure_start: "1990-01-01", location_name: "Base Camp" },
  { tort_type: "Ozempic / Mounjaro / Wegovy", diagnosis: "Gastroparesis", exposure_start: "2022-03-10" },
  { tort_type: "AFFF / PFAS", diagnosis: "Ulcerative Colitis", exposure_start: "2010-01-01", location_name: "Airport" },
  { tort_type: "Asbestos", diagnosis: "Mesothelioma", exposure_start: "1980-01-01", exposure_end: "1995-01-01", location_name: "Shipyard" },
  { tort_type: "Unknown Tort", diagnosis: "Headache" },
];

function benchmarkValidateTortClaim(iterations = 100000) {
  const start = performance.now();
  for (let i = 0; i < iterations; i++) {
    const claim = SAMPLE_CLAIMS[i % SAMPLE_CLAIMS.length];
    validateTortClaim(claim);
  }
  const end = performance.now();
  const totalMs = end - start;
  const perOpMs = totalMs / iterations;
  console.log(`validateTortClaim: ${totalMs.toFixed(2)} ms total, ${perOpMs.toFixed(6)} ms / call (${iterations} ops)`);
}

function benchmarkGetTortCategories(iterations = 100000) {
  const start = performance.now();
  for (let i = 0; i < iterations; i++) {
    getTortCategories();
  }
  const end = performance.now();
  const totalMs = end - start;
  const perOpMs = totalMs / iterations;
  console.log(`getTortCategories: ${totalMs.toFixed(2)} ms total, ${perOpMs.toFixed(6)} ms / call (${iterations} ops)`);
}

console.log("--- Baseline Benchmark ---");
benchmarkValidateTortClaim();
benchmarkGetTortCategories();
