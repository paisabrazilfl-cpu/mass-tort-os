import { deepScan, scanValue } from "../ids";

const samplePayloads = [
  {
    first_name: "Jane",
    last_name: "Doe",
    email: "jane.doe@example.com",
    phone: "555-123-4567",
    tort_type: "Roundup",
    address: { street: "123 Main St", city: "Austin", state: "TX", zip: "78701" },
    custom_fields: { source: "google_ads", campaign_id: "c-10293", tags: ["web", "organic", "qualified"] },
    notes: "Patient was diagnosed in 2022 after exposure to herbicide."
  },
  {
    search: "Roundup litigation status",
    filters: { page: "1", limit: "50", sort: "created_at", order: "desc" },
    facets: ["tort_type", "status", "assigned_user"]
  },
  {
    batch: [
      { id: 101, status: "approved", metadata: { retries: 0, priority: "high" } },
      { id: 102, status: "pending", metadata: { retries: 1, priority: "low" } },
      { id: 103, status: "review_required", metadata: { retries: 0, priority: "normal" } }
    ]
  }
];

const iterations = 100000;

console.log(`Running IDS deepScan benchmarks with ${iterations} iterations...`);

function benchmark(name: string, fn: () => void) {
  const start = performance.now();
  for (let i = 0; i < iterations; i++) {
    fn();
  }
  const end = performance.now();
  const totalCalls = iterations * samplePayloads.length;
  console.log(`${name}: ${(end - start).toFixed(4)}ms total for ${totalCalls} payload scans, ${((end - start) / totalCalls).toFixed(6)}ms avg per scan`);
}

benchmark("deepScan", () => {
  for (const payload of samplePayloads) {
    deepScan(payload);
  }
});

benchmark("scanValue clean string", () => {
  scanValue("Patient was diagnosed in 2022 after exposure to herbicide.");
});

benchmark("scanValue threat string", () => {
  scanValue("<script>alert(1)</script>");
});
