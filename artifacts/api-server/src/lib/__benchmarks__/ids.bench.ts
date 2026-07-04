import { scanValue, deepScan } from "../ids";

const iterations = 100000;

const safeString = "This is a perfectly safe string with no injection markers at all.";
const maliciousString = "SELECT * FROM users WHERE id = '1' OR '1' = '1'";

const largeObject = {
  user: {
    id: 12345,
    name: "John Doe",
    email: "john.doe@example.com",
    profile: {
      bio: "Just a regular user",
      settings: {
        theme: "dark",
        notifications: true
      }
    }
  },
  data: [
    { id: 1, value: "some value" },
    { id: 2, value: "another value" },
    { id: 3, value: "yet another value" },
    { id: 4, value: "safe string here" },
    { id: 5, value: "more data" }
  ],
  metadata: {
    created_at: "2025-01-01T00:00:00Z",
    updated_at: "2025-01-01T12:00:00Z",
    tags: ["user", "active", "premium"]
  }
};

const maliciousObject = JSON.parse(JSON.stringify(largeObject));
maliciousObject.data[4].value = "'; DROP TABLE users; --";

function benchmark(name: string, fn: () => void) {
  const start = performance.now();
  for (let i = 0; i < iterations; i++) {
    fn();
  }
  const end = performance.now();
  console.log(`${name}: ${(end - start).toFixed(4)}ms (total), ${((end - start) / iterations).toFixed(6)}ms (avg)`);
}

console.log(`Running IDS benchmarks with ${iterations} iterations...`);

benchmark("scanValue (safe)", () => {
  scanValue(safeString);
});

benchmark("scanValue (malicious)", () => {
  scanValue(maliciousString);
});

benchmark("deepScan (safe)", () => {
  deepScan(largeObject);
});

benchmark("deepScan (malicious)", () => {
  deepScan(maliciousObject);
});
