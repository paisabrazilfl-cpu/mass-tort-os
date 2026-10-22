import { scanValue, deepScan } from "../ids";

const testPayloads = [
  "John Smith",
  "john.smith@example.com",
  "555-123-4567",
  "123 Main St, Apt 4B, New York, NY 10001",
  "Claimant was diagnosed in 2021 following exposure at work.",
  "Roundup / Glyphosate Claim Review",
  "https://example.com/api/v1/leads?page=2&limit=50",
  "SELECT * FROM users WHERE 1=1",
  "<script>alert('xss')</script>",
  "../../etc/passwd",
];

const testNestedObject = {
  first_name: "John",
  last_name: "Smith",
  email: "john.smith@example.com",
  phone: "555-123-4567",
  address: "123 Main St",
  city: "New York",
  state: "NY",
  zip: "10001",
  notes: "Claimant was diagnosed in 2021 following exposure at work.",
  metadata: {
    source: "web_form",
    campaign: "roundup",
    referrer: "https://google.com",
  },
};

const iterations = 400_000;

console.log(`Running IDS benchmarks with ${iterations} iterations...`);

const startValue = performance.now();
for (let i = 0; i < iterations; i++) {
  const payload = testPayloads[i % testPayloads.length]!;
  scanValue(payload);
}
const endValue = performance.now();
const elapsedValue = endValue - startValue;

console.log(
  `scanValue: ${elapsedValue.toFixed(4)}ms total, ${(elapsedValue / iterations).toFixed(6)}ms avg per call`
);

const startDeep = performance.now();
for (let i = 0; i < iterations; i++) {
  deepScan(testNestedObject);
}
const endDeep = performance.now();
const elapsedDeep = endDeep - startDeep;

console.log(
  `deepScan: ${elapsedDeep.toFixed(4)}ms total, ${(elapsedDeep / iterations).toFixed(6)}ms avg per call`
);
