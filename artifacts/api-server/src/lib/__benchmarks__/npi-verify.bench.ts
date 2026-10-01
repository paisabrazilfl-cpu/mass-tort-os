import { __test } from "../npi-verify";

const { pickBestSearchResult, providerTaxonomyMatches, summarizeProvider } = __test;

const mockResults = Array.from({ length: 20 }, (_, i) => ({
  number: 1234567890 + i,
  basic: {
    first_name: "John",
    last_name: `Doe${i}`,
    organization_name: `General Hospital ${i}`,
  },
  addresses: [
    {
      address_purpose: "LOCATION",
      city: "San Francisco",
      state: "CA",
      address_1: "123 Market St",
      postal_code: "94105",
      telephone_number: "4155551234",
      fax_number: "4155555678",
    },
    {
      address_purpose: "MAILING",
      city: "Oakland",
      state: "CA",
      address_1: "456 Broadway",
      postal_code: "94607",
    },
  ],
  taxonomies: [
    { code: "207Q00000X", desc: "Family Medicine", primary: true },
    { code: "207R00000X", desc: "Internal Medicine Physician", primary: false },
    { code: "207Q00002X", desc: "Sports Medicine", primary: false },
  ],
}));

const expectedProvider = {
  name: "Dr. John Doe",
  organization: "General Hospital",
  city: "San Francisco",
  state: "CA",
  specialty: "general practitioner",
};

const iterations = 50000;

console.log(`Running NPI verifier benchmark over ${iterations} iterations...`);

function benchmark(name: string, fn: () => void) {
  const start = performance.now();
  for (let i = 0; i < iterations; i++) {
    fn();
  }
  const end = performance.now();
  console.log(`${name}: ${(end - start).toFixed(4)}ms (total), ${((end - start) / iterations).toFixed(6)}ms (avg)`);
}

benchmark("pickBestSearchResult (20 candidates)", () => {
  pickBestSearchResult(mockResults, expectedProvider);
});

benchmark("providerTaxonomyMatches", () => {
  providerTaxonomyMatches(mockResults[0], "general practitioner");
});

benchmark("summarizeProvider", () => {
  summarizeProvider(mockResults[0]);
});
