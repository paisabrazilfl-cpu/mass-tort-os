import { __test } from "../artifacts/api-server/src/lib/npi-verify";
const { pickBestSearchResult } = __test;

const results = [
  {
    number: "1234567890",
    basic: { first_name: "Micah", last_name: "Edwin", organization_name: "" },
    addresses: [{ address_purpose: "LOCATION", city: "New York", state: "NY" }]
  },
  {
    number: "0987654321",
    basic: { first_name: "John", last_name: "Smith", organization_name: "" },
    addresses: [{ address_purpose: "LOCATION", city: "Los Angeles", state: "CA" }]
  },
  {
    number: "1122334455",
    basic: { first_name: "Jane", last_name: "Doe", organization_name: "Doe Clinic" },
    addresses: [{ address_purpose: "LOCATION", city: "Chicago", state: "IL" }]
  }
];

const expected = {
  name: "Micah Edwin",
  city: "New York",
  state: "NY"
};

const iterations = 100000;

console.log(`Running NPI search benchmarks with ${iterations} iterations...`);

const start = performance.now();
for (let i = 0; i < iterations; i++) {
  pickBestSearchResult(results, expected);
}
const end = performance.now();

console.log(`Total time: ${(end - start).toFixed(4)}ms`);
console.log(`Avg time per call: ${((end - start) / iterations).toFixed(6)}ms`);
