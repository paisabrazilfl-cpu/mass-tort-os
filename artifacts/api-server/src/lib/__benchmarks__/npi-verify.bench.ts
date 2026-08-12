import { __test } from "../npi-verify";

const { pickBestSearchResult } = __test;

const candidates = [
  {
    number: "1111111111",
    basic: { first_name: "John", last_name: "Smith", organization_name: "" },
    addresses: [
      { address_purpose: "MAILING", city: "New York", state: "NY" },
      { address_purpose: "LOCATION", city: "Brooklyn", state: "NY" },
    ],
  },
  {
    number: "2222222222",
    basic: { first_name: "Jon", last_name: "Smyth", organization_name: "" },
    addresses: [
      { address_purpose: "LOCATION", city: "Manhattan", state: "NY" },
    ],
  },
  {
    number: "3333333333",
    basic: { first_name: "Jonathan", last_name: "Smithers", organization_name: "" },
    addresses: [
      { address_purpose: "LOCATION", city: "Queens", state: "NY" },
    ],
  },
  {
    number: "4444444444",
    basic: { first_name: "John", last_name: "Smith", organization_name: "" },
    addresses: [
      { address_purpose: "LOCATION", city: "Philadelphia", state: "PA" },
    ],
  },
  {
    number: "5555555555",
    basic: { first_name: "Jane", last_name: "Smith", organization_name: "" },
    addresses: [
      { address_purpose: "LOCATION", city: "Brooklyn", state: "NY" },
    ],
  },
];

const expected = {
  name: "Dr. John Smith, MD",
  city: "Brooklyn",
  state: "NY",
};

const iterations = 50000;

console.log(`Running NPI search benchmarks with ${iterations} iterations...`);

const start = performance.now();
for (let i = 0; i < iterations; i++) {
  pickBestSearchResult(candidates, expected);
}
const end = performance.now();

console.log(`pickBestSearchResult: ${(end - start).toFixed(4)}ms (total), ${((end - start) / iterations).toFixed(6)}ms (avg)`);
