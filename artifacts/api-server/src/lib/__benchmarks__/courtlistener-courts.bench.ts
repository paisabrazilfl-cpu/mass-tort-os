import { normalizeStateCode, getCourtsForState, getStateLabel } from "../courtlistener-courts";

const testInputs = [
  "California",
  "New Jersey",
  "north carolina",
  "CA",
  "nj",
  "Texas",
  "Unknown State",
  "Florida",
];

const iterations = 100000;

console.log(`Running CourtListener Courts benchmarks with ${iterations} iterations per input...`);

function benchmark(name: string, fn: () => void) {
  const start = performance.now();
  for (let i = 0; i < iterations; i++) {
    fn();
  }
  const end = performance.now();
  const totalMs = end - start;
  const avgMs = totalMs / (iterations * testInputs.length);
  console.log(`${name}: ${totalMs.toFixed(4)}ms (total for ${iterations * testInputs.length} ops), ${avgMs.toFixed(6)}ms (avg per op)`);
}

benchmark("normalizeStateCode", () => {
  for (const input of testInputs) {
    normalizeStateCode(input);
  }
});

benchmark("getCourtsForState", () => {
  for (const input of testInputs) {
    getCourtsForState(input);
  }
});

benchmark("getStateLabel", () => {
  for (const input of testInputs) {
    getStateLabel(input);
  }
});
