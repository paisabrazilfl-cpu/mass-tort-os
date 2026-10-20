import { validateTortClaim, getTortCategories } from "../tort-engine.js";

const iterations = 500000;

const sampleInputs = [
  {
    tort_type: "Roundup",
    diagnosis: "Non-Hodgkin Lymphoma",
    exposure_start: "2015-01-01",
  },
  {
    tort_type: "roundup",
    diagnosis: "Non-Hodgkin Lymphoma",
    exposure_start: "2015-01-01",
  },
  {
    tort_type: "camp-lejeune",
    diagnosis: "kidney cancer",
    exposure_start: "1965-06-15",
    exposure_end: "1972-08-20",
    location_name: "Camp Lejeune Base",
  },
  {
    tort_type: "Camp Lejeune",
    diagnosis: "leukemia",
    exposure_start: "1995-01-01", // triggers exposure range check error
    exposure_end: "1998-01-01",
    location_name: "Camp Lejeune Base",
  },
  {
    tort_type: "AFFF / PFAS",
    diagnosis: "ulcerative colitis",
    exposure_start: "2012-03-01",
    location_name: "Fire Station #4",
  },
  {
    tort_type: "unknown_tort",
    diagnosis: "headache",
  },
];

console.log(`Running tort-engine benchmarks across ${iterations} iterations...`);

function benchmark(name: string, fn: () => void) {
  const start = performance.now();
  for (let i = 0; i < iterations; i++) {
    fn();
  }
  const end = performance.now();
  const totalMs = end - start;
  console.log(`${name}: ${totalMs.toFixed(4)}ms total | ${(totalMs / iterations).toFixed(6)}ms per call`);
}

benchmark("validateTortClaim", () => {
  const input = sampleInputs[Math.floor(Math.random() * sampleInputs.length)];
  validateTortClaim(input);
});

benchmark("validateTortClaim (deterministic loop)", () => {
  for (let idx = 0; idx < sampleInputs.length; idx++) {
    validateTortClaim(sampleInputs[idx]);
  }
});

benchmark("getTortCategories", () => {
  getTortCategories();
});
