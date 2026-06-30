import { __test, ExpectedProvider } from "../npi-verify";
const { pickBestSearchResult } = __test;

const expected: ExpectedProvider = {
  name: "Dr. Micah Edwin, MD",
  organization: "Micah Edwin Medical Group",
  city: "Lauderdale Lakes",
  state: "FL",
  specialty: "General practitioner",
};

const results = Array.from({ length: 20 }, (_, i) => ({
  number: `123456789${i}`,
  basic: {
    first_name: i === 5 ? "Micah" : "John",
    last_name: i === 5 ? "Edwin" : "Smith",
    organization_name: i === 10 ? "Micah Edwin Medical Group" : "Other Corp",
  },
  addresses: [
    {
      address_purpose: "LOCATION",
      city: i === 5 || i === 10 ? "Lauderdale Lakes" : "Tallahassee",
      state: "FL",
    },
  ],
  taxonomies: [
    { code: "207Q00000X", desc: "Family Medicine", primary: true },
  ],
}));

const iterations = 10000;

console.log(`Running NPI Search Benchmark (${iterations} iterations)...`);

const start = performance.now();
for (let i = 0; i < iterations; i++) {
  pickBestSearchResult(results, expected);
}
const end = performance.now();

console.log(`pickBestSearchResult (20 results): ${(end - start).toFixed(4)}ms (total), ${((end - start) / iterations).toFixed(6)}ms (avg)`);
