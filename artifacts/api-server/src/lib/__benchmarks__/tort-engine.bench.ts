import { validateTortClaim, getTortCategories } from "../tort-engine";

const testCases = [
  { tort_type: "Roundup", diagnosis: "Non-Hodgkin Lymphoma", exposure_start: "2010-01-01" },
  { tort_type: "paraquat", diagnosis: "Parkinson's disease", exposure_start: "2015-05-01" },
  { tort_type: "Camp Lejeune", diagnosis: "Kidney Cancer", exposure_start: "1965-01-01", exposure_end: "1970-01-01", location_name: "Camp Lejeune" },
  { tort_type: "ozempic", diagnosis: "Gastroparesis", exposure_start: "2022-01-01" },
  { tort_type: "unknown-tort", diagnosis: "headache" },
];

const iterations = 100000;

console.log(`Running tort-engine benchmarks with ${iterations} iterations...`);

function benchmark(name: string, fn: () => void) {
  const start = performance.now();
  for (let i = 0; i < iterations; i++) {
    fn();
  }
  const end = performance.now();
  console.log(`${name}: ${(end - start).toFixed(4)}ms (total), ${((end - start) / iterations).toFixed(6)}ms (avg)`);
}

benchmark("validateTortClaim", () => {
  for (let i = 0; i < testCases.length; i++) {
    validateTortClaim(testCases[i]);
  }
});

benchmark("getTortCategories", () => {
  getTortCategories();
});
