
import { idsMiddleware } from "../ids";
import { Request, Response } from "express";

// We need to mock the DB because ids.ts imports it
// Since we are running with tsx, we can try to provide a dummy DATABASE_URL
process.env.DATABASE_URL = "postgres://localhost:5432/test";

// We'll manually test the scan logic by extracting it or using the middleware
// Since scanValue is not exported, we'll have to use the middleware or
// modify ids.ts to export it for benchmarking.

// Let's see if we can just benchmark the middleware's logic.
// But middleware does DB calls (isBlocked).

// Better to export the internal functions for testing/benchmarking.
// I'll modify ids.ts to export scanValue and deepScan.

import { scanValue, deepScan } from "../ids";

const suite = [
  { name: "safe string", value: "Hello world, this is a normal string." },
  { name: "sql injection", value: "'; DROP TABLE users; --" },
  { name: "xss", value: "<script>alert('xss')</script>" },
  { name: "path traversal", value: "../../../etc/passwd" },
  { name: "command injection", value: "; cat /etc/passwd" },
];

const largeObject = {
  user: {
    name: "John Doe",
    bio: "I like to code and sometimes I use '; DROP TABLE users; -- in my bio",
    settings: {
      theme: "dark",
      notifications: true,
    }
  },
  posts: [
    { id: 1, title: "Hello", content: "World" },
    { id: 2, title: "XSS", content: "<img src=x onerror=alert(1)>" }
  ]
};

function bench() {
  const iterations = 100000;

  console.log(`Running benchmark with ${iterations} iterations...`);

  // Benchmark scanValue
  console.time("scanValue (safe)");
  for (let i = 0; i < iterations; i++) {
    scanValue(suite[0].value);
  }
  console.timeEnd("scanValue (safe)");

  console.time("scanValue (threat)");
  for (let i = 0; i < iterations; i++) {
    scanValue(suite[1].value);
  }
  console.timeEnd("scanValue (threat)");

  // Benchmark deepScan
  console.time("deepScan (large object)");
  for (let i = 0; i < iterations / 10; i++) {
    deepScan(largeObject);
  }
  console.timeEnd("deepScan (large object)");
}

bench();
