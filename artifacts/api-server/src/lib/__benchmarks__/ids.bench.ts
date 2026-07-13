import { Request } from "express";
import { __test_ids } from "../ids";

const { scanValue, deepScan } = __test_ids;

const iterations = 100000;

const safeObject = {
  name: "John Doe",
  email: "john@example.com",
  note: "Please call me back regarding the Roundup case. I was diagnosed last year.",
  meta: {
    source: "web-form",
    id: 12345,
    tags: ["urgent", "new-lead"]
  }
};

const attackObject = {
  name: "John Doe",
  email: "john@example.com",
  note: "Please call me back. '; DROP TABLE leads; --",
  meta: {
    source: "web-form",
    id: 12345,
    tags: ["<script>alert(1)</script>"]
  }
};

console.log(`Running IDS scanning benchmarks with ${iterations} iterations...`);

function benchmark(name: string, fn: () => void) {
  const start = performance.now();
  for (let i = 0; i < iterations; i++) {
    fn();
  }
  const end = performance.now();
  console.log(`${name}: ${(end - start).toFixed(4)}ms (total), ${((end - start) / iterations).toFixed(6)}ms (avg)`);
}

benchmark("scanValue (safe string)", () => {
  scanValue("Please call me back regarding the Roundup case. I was diagnosed last year.");
});

benchmark("scanValue (attack string)", () => {
  scanValue("'; DROP TABLE leads; --");
});

benchmark("deepScan (safe object)", () => {
  deepScan(safeObject);
});

benchmark("deepScan (attack object)", () => {
  deepScan(attackObject);
});
