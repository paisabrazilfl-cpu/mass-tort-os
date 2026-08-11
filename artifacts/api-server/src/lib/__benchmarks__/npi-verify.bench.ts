import { __test } from "../npi-verify";
import { ExpectedProvider } from "../npi-verify";

const expected: ExpectedProvider = {
  name: "Dr. Micah Edwin, MD",
  organization: "Micah Edwin Clinic",
  city: "Lauderdale Lakes",
  state: "FL",
};

const results = [
  {
    number: "1234567890",
    basic: { first_name: "Micah", last_name: "Edwin", organization_name: "Micah Edwin Clinic" },
    addresses: [
      { address_purpose: "MAILING", city: "Tallahassee", state: "FL" },
      { address_purpose: "LOCATION", city: "Lauderdale Lakes", state: "FL" },
    ],
  },
  {
    number: "2234567890",
    basic: { first_name: "John", last_name: "Edwin", organization_name: "John Edwin Clinic" },
    addresses: [
      { address_purpose: "LOCATION", city: "Miami", state: "FL" },
    ],
  },
  {
    number: "3234567890",
    basic: { first_name: "Micah", last_name: "Smith", organization_name: "" },
    addresses: [
      { address_purpose: "LOCATION", city: "Lauderdale Lakes", state: "FL" },
    ],
  },
];

const iterations = 50000;

console.log(`Running NPI Search pickBestSearchResult benchmark with ${iterations} iterations...`);

const start = performance.now();
for (let i = 0; i < iterations; i++) {
  __test.pickBestSearchResult(results, expected);
}
const end = performance.now();

console.log(`pickBestSearchResult: ${(end - start).toFixed(4)}ms (total), ${((end - start) / iterations).toFixed(6)}ms (avg)`);
