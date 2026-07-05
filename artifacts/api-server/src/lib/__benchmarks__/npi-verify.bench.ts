import { __test, ExpectedProvider } from "../npi-verify";

const { pickBestSearchResult } = __test;

const results = Array.from({ length: 20 }, (_, i) => ({
  number: String(1000000000 + i),
  basic: {
    first_name: i % 2 === 0 ? "Micah" : "John",
    last_name: i % 2 === 0 ? "Edwin" : "Smith",
    organization_name: i % 3 === 0 ? "Edwin Medical Group" : "",
  },
  addresses: [
    {
      address_purpose: "LOCATION",
      city: i % 4 === 0 ? "Lauderdale Lakes" : "Miami",
      state: "FL",
    },
  ],
}));

const expected: ExpectedProvider = {
  name: "Dr. Micah Edwin, MD",
  organization: "Edwin Medical Group",
  city: "Lauderdale Lakes",
  state: "FL",
};

const iterations = 10000;

console.log(`Running NPI verify benchmarks with ${iterations} iterations...`);

const start = performance.now();
for (let i = 0; i < iterations; i++) {
  pickBestSearchResult(results, expected);
}
const end = performance.now();
console.log(`pickBestSearchResult: ${(end - start).toFixed(4)}ms (total), ${((end - start) / iterations).toFixed(6)}ms (avg)`);
