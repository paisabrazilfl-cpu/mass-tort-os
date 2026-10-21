import { performance } from "node:perf_hooks";
import { validateAddress } from "../address-validator";

function runBenchmark() {
  const testAddresses = [
    { street_address: "123 Main St", city: "Springfield", state: "IL", zip: "62701" },
    { street_address: "", city: "Chicago", state: "il", zip: "60601-1234" },
    { street_address: "456 Oak Ave", city: "X", state: "INVALID", zip: "abc" },
    { street_address: "asdf", city: "test", state: "CA", zip: "90210" },
    { street_address: "789 Pine Rd", city: "San Francisco", state: "NY", zip: "10001" },
  ];

  const iterations = 1_000_000;

  // Warmup
  for (let i = 0; i < 50_000; i++) {
    validateAddress(testAddresses[i % testAddresses.length]);
  }

  const start = performance.now();
  for (let i = 0; i < iterations; i++) {
    validateAddress(testAddresses[i % testAddresses.length]);
  }
  const elapsed = performance.now() - start;

  const nsPerCall = (elapsed / iterations) * 1_000_000;
  const usPerCall = nsPerCall / 1000;
  const opsPerSec = (iterations / elapsed) * 1000;

  console.log(`=== Address Validator Benchmark ===`);
  console.log(`Total Iterations: ${iterations.toLocaleString()}`);
  console.log(`Total Time:       ${elapsed.toFixed(2)} ms`);
  console.log(`Latency per call: ${usPerCall.toFixed(4)} µs (${nsPerCall.toFixed(1)} ns)`);
  console.log(`Throughput:       ${Math.round(opsPerSec).toLocaleString()} ops/sec`);
}

if (process.argv[1]?.endsWith("address-validator.bench.ts")) {
  runBenchmark();
}
