import { __test } from "../npi-verify";
import type { NpiRegistryResult, ExpectedProvider } from "../npi-verify";

const { pickBestSearchResult } = __test;

const mockResults: NpiRegistryResult[] = Array.from({ length: 20 }, (_, i) => ({
  number: 1000000000 + i,
  enumeration_type: "NPI-1",
  basic: {
    first_name: i % 2 === 0 ? "Micah" : "Michael",
    last_name: "Edwin",
    organization_name: i % 5 === 0 ? "Edwin Medical Center LLC" : undefined,
    credential: i % 3 === 0 ? "MD" : undefined,
  },
  addresses: [
    {
      address_purpose: "LOCATION",
      address_1: "123 Main St",
      city: i % 4 === 0 ? "New York" : "Albany",
      state: "NY",
      postal_code: "10001",
    },
  ],
  taxonomies: [
    { code: "207Q00000X", desc: "Family Medicine", primary: true },
  ],
}));

const expected: ExpectedProvider = {
  name: "Dr. Micah Edwin, MD",
  organization: "Edwin Medical",
  city: "New York",
  state: "NY",
  specialty: "family doctor",
};

const iterations = 50000;

console.log(`Running NPI pickBestSearchResult benchmark with ${iterations} iterations...`);

const start = performance.now();
for (let i = 0; i < iterations; i++) {
  pickBestSearchResult(mockResults, expected);
}
const end = performance.now();

console.log(`pickBestSearchResult: ${(end - start).toFixed(4)}ms total, ${((end - start) / iterations).toFixed(6)}ms avg per call`);
