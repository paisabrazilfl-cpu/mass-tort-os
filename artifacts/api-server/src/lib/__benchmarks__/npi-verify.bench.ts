import { __test } from "../npi-verify";

const expected = {
  name: "Dr. Micah Edwin, MD",
  organization: "",
  city: "Lauderdale Lakes",
  state: "FL",
};

const resultsNormal = [
  {
    number: "1111111111",
    basic: { first_name: "John", last_name: "Smith", organization_name: "" },
    addresses: [{ address_purpose: "LOCATION", city: "Miami", state: "FL" }],
  },
  {
    number: "2222222222",
    basic: { first_name: "Jane", last_name: "Doe", organization_name: "" },
    addresses: [{ address_purpose: "LOCATION", city: "Orlando", state: "FL" }],
  },
  {
    number: "1234567890",
    basic: { first_name: "Micah", last_name: "Edwin", organization_name: "" },
    addresses: [
      { address_purpose: "MAILING", city: "Tallahassee", state: "FL" },
      { address_purpose: "LOCATION", city: "Lauderdale Lakes", state: "FL" },
    ],
  },
  {
    number: "3333333333",
    basic: { first_name: "Bob", last_name: "Johnson", organization_name: "" },
    addresses: [{ address_purpose: "LOCATION", city: "Tampa", state: "FL" }],
  },
];

const resultsPerfectFirst = [
  {
    number: "1234567890",
    basic: { first_name: "Micah", last_name: "Edwin", organization_name: "" },
    addresses: [
      { address_purpose: "MAILING", city: "Tallahassee", state: "FL" },
      { address_purpose: "LOCATION", city: "Lauderdale Lakes", state: "FL" },
    ],
  },
  {
    number: "1111111111",
    basic: { first_name: "John", last_name: "Smith", organization_name: "" },
    addresses: [{ address_purpose: "LOCATION", city: "Miami", state: "FL" }],
  },
  {
    number: "2222222222",
    basic: { first_name: "Jane", last_name: "Doe", organization_name: "" },
    addresses: [{ address_purpose: "LOCATION", city: "Orlando", state: "FL" }],
  },
  {
    number: "3333333333",
    basic: { first_name: "Bob", last_name: "Johnson", organization_name: "" },
    addresses: [{ address_purpose: "LOCATION", city: "Tampa", state: "FL" }],
  },
];

const iterations = 50000;

console.log(`Running NPI Verify benchmarks with ${iterations} iterations...`);

const startNormal = performance.now();
for (let i = 0; i < iterations; i++) {
  __test.pickBestSearchResult(resultsNormal, expected);
}
const endNormal = performance.now();

const startPerfect = performance.now();
for (let i = 0; i < iterations; i++) {
  __test.pickBestSearchResult(resultsPerfectFirst, expected);
}
const endPerfect = performance.now();

console.log(
  `pickBestSearchResult (perfect match 3rd): ${(endNormal - startNormal).toFixed(4)}ms (total), ${((endNormal - startNormal) / iterations).toFixed(6)}ms (avg)`,
);
console.log(
  `pickBestSearchResult (perfect match 1st): ${(endPerfect - startPerfect).toFixed(4)}ms (total), ${((endPerfect - startPerfect) / iterations).toFixed(6)}ms (avg)`,
);
