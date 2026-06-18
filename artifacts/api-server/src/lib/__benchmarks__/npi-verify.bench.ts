import { __test, ExpectedProvider } from "../npi-verify";

const { pickBestSearchResult } = __test;

const expected: ExpectedProvider = {
  name: "Dr. Micah Edwin, MD",
  organization: "Micah Edwin Medical Group",
  city: "Lauderdale Lakes",
  state: "FL",
};

const results = [
  {
    number: "1111111111",
    basic: { first_name: "John", last_name: "Doe", organization_name: "Other Clinic" },
    addresses: [{ address_purpose: "LOCATION", city: "Miami", state: "FL" }],
  },
  {
    number: "2222222222",
    basic: { first_name: "Micah", last_name: "Edwin", organization_name: "" },
    addresses: [{ address_purpose: "LOCATION", city: "Lauderdale Lakes", state: "FL" }],
  },
  {
    number: "3333333333",
    basic: { first_name: "Jane", last_name: "Smith", organization_name: "Smith Org" },
    addresses: [{ address_purpose: "LOCATION", city: "Orlando", state: "FL" }],
  },
];

const iterations = 10000;

console.log(`Running npi-verify benchmarks with ${iterations} iterations (looping over 3 results)...`);

function benchmark(name: string, fn: () => void) {
  const start = performance.now();
  for (let i = 0; i < iterations; i++) {
    fn();
  }
  const end = performance.now();
  console.log(`${name}: ${(end - start).toFixed(4)}ms (total), ${((end - start) / iterations).toFixed(6)}ms (avg)`);
}

benchmark("pickBestSearchResult", () => {
  pickBestSearchResult(results, expected);
});
