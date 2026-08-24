import { normalizeStateCode, getCourtsForState } from "../courtlistener-courts";

const stateInputs = [
  "California",
  "New Jersey",
  "north carolina",
  "DISTRICT OF COLUMBIA",
  "Texas",
  "Florida",
  "Wyoming",
  " Washington ",
  "nj",
  "CA",
  "ZZ",
];

const iterations = 100000;

console.log(`Running CourtListener Courts benchmarks with ${iterations} iterations...`);

function benchmark(name: string, fn: () => void) {
  const start = performance.now();
  for (let i = 0; i < iterations; i++) {
    fn();
  }
  const end = performance.now();
  console.log(`${name}: ${(end - start).toFixed(4)}ms (total), ${((end - start) / iterations).toFixed(6)}ms (avg)`);
}

benchmark("normalizeStateCode (full names and codes)", () => {
  for (const input of stateInputs) {
    normalizeStateCode(input);
  }
});

benchmark("getCourtsForState (full state names)", () => {
  getCourtsForState("New Jersey");
  getCourtsForState("California");
  getCourtsForState("Washington");
});
