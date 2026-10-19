import { normalizeStateCode, getCourtsForState, getStateLabel } from "../courtlistener-courts";

const testInputs = [
  "NJ",
  "nj",
  " New Jersey ",
  "NORTH CAROLINA",
  "district of columbia",
  "California",
  "tx",
  "Texas",
  "UNKNOWN_STATE",
  "",
];

const iterations = 500000;

console.log(`Running courtlistener-courts benchmarks with ${iterations} iterations...`);

function benchmark(name: string, fn: () => void) {
  const start = performance.now();
  for (let i = 0; i < iterations; i++) {
    fn();
  }
  const end = performance.now();
  console.log(`${name}: ${(end - start).toFixed(4)}ms (total), ${((end - start) / iterations).toFixed(6)}ms (avg)`);
}

benchmark("normalizeStateCode across 10 sample inputs", () => {
  for (let i = 0; i < testInputs.length; i++) {
    normalizeStateCode(testInputs[i]);
  }
});

benchmark("getCourtsForState across 10 sample inputs", () => {
  for (let i = 0; i < testInputs.length; i++) {
    getCourtsForState(testInputs[i]);
  }
});

benchmark("getStateLabel across 10 sample inputs", () => {
  for (let i = 0; i < testInputs.length; i++) {
    getStateLabel(testInputs[i]);
  }
});
