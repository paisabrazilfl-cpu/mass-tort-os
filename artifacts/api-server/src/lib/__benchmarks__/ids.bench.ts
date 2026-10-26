import { performance } from "perf_hooks";
import { idsMiddleware } from "../ids";

function runMiddlewareBatch(middleware: any, reqs: any[]) {
  const dummyRes = {
    status() { return this; },
    json() { return this; },
  };
  let passed = 0;
  for (const req of reqs) {
    middleware(req, dummyRes, () => {
      passed++;
    });
  }
  return passed;
}

const middleware = idsMiddleware();

const sampleRequests = [];
for (let i = 0; i < 1000; i++) {
  sampleRequests.push(
    {
      originalUrl: "/api/leads?status=pending&page=1&limit=20&sort=desc",
      query: { status: "pending", page: "1", limit: "20", sort: "desc", tort: "Roundup" },
      body: { name: "Jane Doe", email: "jane@example.com", phone: "555-123-4567", state: "CA", firm_id: 1, age: 45 },
      headers: {},
      socket: { remoteAddress: `10.0.${Math.floor(i / 250)}.${i % 250}` },
    },
    {
      originalUrl: "/api/cases/123/documents",
      query: { filter: "all", draft: "false" },
      body: { title: "Medical Record Intake", category: "medical", status: "active", verified: true },
      headers: {},
      socket: { remoteAddress: `10.1.${Math.floor(i / 250)}.${i % 250}` },
    },
    {
      originalUrl: "/api/decision-engine/evaluate",
      query: { debug: "0" },
      body: {
        claimant: { firstName: "John", lastName: "Smith", dob: "1975-08-12", gender: "M" },
        exposures: [{ product: "Roundup", startYear: 2005, endYear: 2018, frequency: "weekly" }],
        diagnoses: [{ code: "C81.9", name: "Hodgkin lymphoma", diagnosedYear: 2020 }],
      },
      headers: {},
      socket: { remoteAddress: `10.2.${Math.floor(i / 250)}.${i % 250}` },
    }
  );
}

const ITERATIONS = 10;

// Warmup
for (let i = 0; i < 2; i++) {
  runMiddlewareBatch(middleware, sampleRequests.slice(0, 100));
}

const start = performance.now();
for (let i = 0; i < ITERATIONS; i++) {
  runMiddlewareBatch(middleware, sampleRequests);
}
const elapsed = performance.now() - start;

const totalReqs = ITERATIONS * sampleRequests.length;
const opsPerSec = Math.round((totalReqs * 1000) / elapsed);
const msPerReq = elapsed / totalReqs;

console.log(`[IDS Benchmark] Elapsed: ${elapsed.toFixed(2)}ms for ${totalReqs} requests`);
console.log(`[IDS Benchmark] Throughput: ${opsPerSec.toLocaleString()} req/sec`);
console.log(`[IDS Benchmark] Average Latency: ${(msPerReq * 1000).toFixed(4)}µs per request`);
