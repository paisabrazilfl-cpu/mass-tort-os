import { scanValue, deepScan } from "../ids.js";

const safeValues = [
  "Hello world",
  "John Doe",
  "12345",
  "This is a normal sentence with no threats.",
  "paralegal notes: Joe and wife both diagnosed",
  "https://example.com/page?id=123",
  "user@example.com"
];

const maliciousValues = [
  "'; DROP TABLE users; --",
  "<script>alert(1)</script>",
  "../../etc/passwd",
  "; cat /etc/passwd"
];

const safeObject = {
  user: {
    name: "John Doe",
    email: "john@example.com",
    bio: "Just a regular user sharing some notes about the case. Joe and wife both diagnosed with something normal.",
  },
  metadata: {
    page: 1,
    limit: 10,
    search: "active cases"
  },
  tags: ["legal", "medical", "notes"]
};

const iterations = 100000;

console.log(`Running benchmarks with ${iterations} iterations...`);

function benchmark(name: string, fn: () => void) {
  const start = performance.now();
  for (let i = 0; i < iterations; i++) {
    fn();
  }
  const end = performance.now();
  const perOp = (end - start) / iterations;
  console.log(`${name}: ${(end - start).toFixed(4)}ms (total), ${perOp.toFixed(6)}ms (avg)`);
}

benchmark("scanValue (safe)", () => {
  for (let i = 0; i < safeValues.length; i++) {
    scanValue(safeValues[i]);
  }
});

benchmark("scanValue (malicious)", () => {
  for (let i = 0; i < maliciousValues.length; i++) {
    scanValue(maliciousValues[i]);
  }
});

benchmark("deepScan (safe object)", () => {
  deepScan(safeObject);
});
