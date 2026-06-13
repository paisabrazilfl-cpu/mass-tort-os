import { __test } from "../npi-verify.js";
const { pickBestSearchResult } = __test;

const results = Array.from({ length: 20 }, (_, i) => ({
  number: 1000000000 + i,
  basic: {
    first_name: "JOHN",
    last_name: "SMITH",
    organization_name: i % 5 === 0 ? "SMITH MEDICAL GROUP" : undefined,
  },
  addresses: [
    {
      address_purpose: "LOCATION",
      city: "NEW YORK",
      state: "NY",
    }
  ],
  taxonomies: [
    { desc: "Internal Medicine", primary: true }
  ]
}));

const expected = {
  name: "JOHN SMITH",
  organization: "SMITH MEDICAL GROUP",
  city: "NEW YORK",
  state: "NY",
};

const iterations = 10000;

console.log(`Running npi-verify benchmark with ${iterations} iterations...`);
const start = performance.now();
for (let i = 0; i < iterations; i++) {
  pickBestSearchResult(results, expected);
}
const end = performance.now();
console.log(`pickBestSearchResult: ${(end - start).toFixed(4)}ms (total), ${((end - start) / iterations).toFixed(6)}ms (avg)`);

const perfectResult = Array.from({ length: 20 }, (_, i) => ({
  number: 1234567890 + i,
  basic: {
    first_name: "JOHN",
    last_name: "SMITH",
    organization_name: "SMITH MEDICAL GROUP",
  },
  addresses: [
    {
      address_purpose: "LOCATION",
      city: "NEW YORK",
      state: "NY",
    }
  ]
}));

console.log(`Running perfect match benchmark with ${iterations} iterations...`);
const start2 = performance.now();
for (let i = 0; i < iterations; i++) {
  pickBestSearchResult(perfectResult, expected);
}
const end2 = performance.now();
console.log(`pickBestSearchResult (perfect match): ${(end2 - start2).toFixed(4)}ms (total), ${((end2 - start2) / iterations).toFixed(6)}ms (avg)`);
