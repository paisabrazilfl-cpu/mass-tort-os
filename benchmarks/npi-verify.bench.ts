import { __test } from "../artifacts/api-server/src/lib/npi-verify";
const { pickBestSearchResult } = __test;

const mockResults = Array.from({ length: 20 }, (_, i) => ({
  number: 1000000000 + i,
  basic: {
    first_name: "John",
    last_name: "Smith",
    organization_name: "General Hospital",
  },
  addresses: [
    {
      address_purpose: "LOCATION",
      city: "New York",
      state: "NY",
    },
  ],
  taxonomies: [
    { desc: "Internal Medicine", primary: true },
  ],
}));

const expected = {
  name: "John Smith",
  organization: "General Hospital",
  city: "New York",
  state: "NY",
  specialty: "Internal Medicine",
};

const iterations = 10000;

console.log(`Running NPI search benchmarks with ${iterations} iterations...`);

function benchmark(name: string, fn: () => void) {
  const start = performance.now();
  for (let i = 0; i < iterations; i++) {
    fn();
  }
  const end = performance.now();
  console.log(`${name}: ${(end - start).toFixed(4)}ms (total), ${((end - start) / iterations).toFixed(6)}ms (avg)`);
}

benchmark("pickBestSearchResult", () => {
  pickBestSearchResult(mockResults, expected);
});
