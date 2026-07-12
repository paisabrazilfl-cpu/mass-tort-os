import { idsMiddleware } from "../ids";
import { Request, Response } from "express";

// Mocking dependencies since we only want to benchmark the scanning logic
// We'll benchmark scanValue and deepScan directly by exporting them for the benchmark
// or by calling the middleware with a mocked request.

import * as ids from "../ids";

const iterations = 100000;

const safeString = "This is a perfectly safe string with no injection markers.";
const maliciousString = "SELECT * FROM users WHERE id = '1' OR '1'='1'";

const safeObject = {
  name: "John Doe",
  email: "john@example.com",
  metadata: {
    notes: "Regular customer",
    tags: ["vip", "legal"]
  }
};

const maliciousObject = {
  name: "Attacker",
  email: "attacker@evil.com",
  comment: "Check this out <script>alert('xss')</script>"
};

// @ts-ignore - accessing internal functions for benchmarking
const scanValue = (ids as any).scanValue;
// @ts-ignore
const deepScan = (ids as any).deepScan;

if (typeof scanValue !== 'function') {
    console.error("scanValue is not exported or not a function. Make sure to export it for benchmarking.");
    process.exit(1);
}

console.log(`Running IDS benchmarks with ${iterations} iterations...\n`);

function benchmark(name: string, fn: () => void) {
  const start = performance.now();
  for (let i = 0; i < iterations; i++) {
    fn();
  }
  const end = performance.now();
  console.log(`${name}: ${(end - start).toFixed(4)}ms (total), ${((end - start) / iterations).toFixed(6)}ms (avg)`);
}

benchmark("scanValue (safe string)", () => {
  scanValue(safeString);
});

benchmark("scanValue (malicious string)", () => {
  scanValue(maliciousString);
});

benchmark("deepScan (safe object)", () => {
  deepScan(safeObject);
});

benchmark("deepScan (malicious object)", () => {
  deepScan(maliciousObject);
});
