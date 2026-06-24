import { __test, ExpectedProvider } from "../npi-verify";
const { pickBestSearchResult } = __test;

const results = Array.from({ length: 20 }, (_, i) => ({
  number: 1000000000 + i,
  basic: {
    first_name: "JOHN",
    last_name: "SMITH",
    organization_name: i % 2 === 0 ? "SMITH MEDICAL" : "",
  },
  addresses: [
    {
      address_purpose: "LOCATION",
      city: "NEW YORK",
      state: "NY",
    }
  ],
  taxonomies: [
    { code: "123", desc: "Internal Medicine", primary: true }
  ]
}));

const expected: ExpectedProvider = {
  name: "John Smith",
  organization: "Smith Medical",
  city: "New York",
  state: "NY",
};

const iterations = 10000;

console.log(`Running npi-verify benchmarks with ${iterations} iterations...`);

const start = performance.now();
for (let i = 0; i < iterations; i++) {
  pickBestSearchResult(results, expected);
}
const end = performance.now();
console.log(`pickBestSearchResult: ${(end - start).toFixed(4)}ms (total), ${((end - start) / iterations).toFixed(6)}ms (avg)`);
