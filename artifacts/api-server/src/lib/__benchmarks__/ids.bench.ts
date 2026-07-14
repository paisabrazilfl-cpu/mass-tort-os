import { Request } from "express";

// We'll need to export these from ids.ts first
// For now, let's assume we will export them.
// @ts-ignore
import { scanValue, deepScan } from "../ids";

const iterations = 10000;

const safeString = "This is a perfectly safe string with no threats.";
const sqlInjectionString = "SELECT * FROM users WHERE id = '1' OR '1'='1'";
const xssString = "<script>alert('xss')</script>";

const safeObject = {
  user: {
    id: 123,
    name: "John Doe",
    bio: "Just a regular user bio without any malicious intent.",
    settings: {
      theme: "dark",
      notifications: true
    }
  },
  items: [
    { id: 1, name: "Item 1" },
    { id: 2, name: "Item 2" }
  ]
};

const maliciousObject = {
  ...safeObject,
  maliciousField: "'; DROP TABLE users; --"
};

console.log(`Running IDS benchmarks with ${iterations} iterations...`);

function benchmark(name: string, fn: () => void) {
  const start = performance.now();
  for (let i = 0; i < iterations; i++) {
    fn();
  }
  const end = performance.now();
  console.log(`${name}: ${(end - start).toFixed(4)}ms (total), ${((end - start) / iterations).toFixed(6)}ms (avg)`);
}

benchmark("scanValue (safe)", () => {
  scanValue(safeString);
});

benchmark("scanValue (SQLi)", () => {
  scanValue(sqlInjectionString);
});

benchmark("scanValue (XSS)", () => {
  scanValue(xssString);
});

benchmark("deepScan (safe object)", () => {
  deepScan(safeObject);
});

benchmark("deepScan (malicious object)", () => {
  deepScan(maliciousObject);
});
