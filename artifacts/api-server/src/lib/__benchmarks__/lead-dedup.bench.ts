import { leadLookupHash } from "../lead-lookup-hash";

function bench() {
  const iterations = 200000;

  console.log(`Running lead-dedup benchmarks with ${iterations} iterations...`);

  const fullInputs = [
    ["Roundup", "john.doe@example.com", "1-800-555-0199"],
    ["Camp Lejeune", "jane.doe@example.com", "(555) 012-3456"],
  ];

  const partialInputs = [
    ["Roundup", "john.doe@example.com", null],
    ["Roundup", null, "1-800-555-0199"],
    [null, "john.doe@example.com", "1-800-555-0199"],
    ["", "", ""],
  ];

  const startFull = performance.now();
  for (let i = 0; i < iterations; i++) {
    const input = fullInputs[i % fullInputs.length]!;
    leadLookupHash(input[0], input[1], input[2]);
  }
  const endFull = performance.now();

  const startPartial = performance.now();
  for (let i = 0; i < iterations; i++) {
    const input = partialInputs[i % partialInputs.length]!;
    leadLookupHash(input[0], input[1], input[2]);
  }
  const endPartial = performance.now();

  console.log(`leadLookupHash (full inputs): ${(endFull - startFull).toFixed(4)}ms total, ${((endFull - startFull) / iterations).toFixed(6)}ms avg`);
  console.log(`leadLookupHash (partial inputs): ${(endPartial - startPartial).toFixed(4)}ms total, ${((endPartial - startPartial) / iterations).toFixed(6)}ms avg`);
}

bench();
