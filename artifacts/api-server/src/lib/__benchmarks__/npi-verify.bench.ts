import { __test } from "../npi-verify";

const expected = {
  name: "Dr. Micah B. Edwin, MD",
  organization: "Micah Edwin Family Medicine",
  city: "Lauderdale Lakes",
  state: "FL",
};

const mockResults = [
  {
    number: "1234567890",
    basic: { first_name: "Micah", last_name: "Edwin", organization_name: "" },
    addresses: [
      { address_purpose: "MAILING", city: "Tallahassee", state: "FL" },
      { address_purpose: "LOCATION", city: "Lauderdale Lakes", state: "FL" },
    ],
  },
  {
    number: "2234567890",
    basic: {
      first_name: "John",
      last_name: "Smith",
      organization_name: "John Smith MD",
    },
    addresses: [{ address_purpose: "LOCATION", city: "Miami", state: "FL" }],
  },
  {
    number: "3234567890",
    basic: { first_name: "Jane", last_name: "Doe", organization_name: "" },
    addresses: [
      { address_purpose: "LOCATION", city: "Lauderdale Lakes", state: "FL" },
    ],
  },
  {
    number: "4234567890",
    basic: {
      first_name: "Micah",
      last_name: "Edwin",
      organization_name: "Micah Edwin MD Practice",
    },
    addresses: [
      { address_purpose: "LOCATION", city: "Tallahassee", state: "FL" },
    ],
  },
  {
    number: "5234567890",
    basic: { first_name: "Bob", last_name: "Jones", organization_name: "" },
    addresses: [{ address_purpose: "LOCATION", city: "Orlando", state: "FL" }],
  },
];

const iterations = 10000;

console.log(
  `Running NPI verify search benchmarks with ${iterations} iterations...`,
);

const start = performance.now();
for (let i = 0; i < iterations; i++) {
  __test.pickBestSearchResult(mockResults, expected);
}
const end = performance.now();

console.log(
  `pickBestSearchResult: ${(end - start).toFixed(4)}ms (total), ${((end - start) / iterations).toFixed(6)}ms (avg)`,
);
