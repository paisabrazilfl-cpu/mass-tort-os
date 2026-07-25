import { __test } from "../npi-verify";

const expected = {
  name: "Dr. Micah Edwin, MD",
  organization: "Family Medicine Group",
  city: "Lauderdale Lakes",
  state: "FL",
};

// Create a pool of 20 mock results to search through
const results = Array.from({ length: 20 }, (_, idx) => ({
  number: `12345678${idx}`,
  basic: {
    first_name: idx === 12 ? "Micah" : "John",
    last_name: idx === 12 ? "Edwin" : `Smith${idx}`,
    organization_name:
      idx === 12 ? "Family Medicine Group" : `Other Group ${idx}`,
  },
  addresses: [
    {
      address_purpose: "LOCATION",
      city: idx === 12 ? "Lauderdale Lakes" : "Miami",
      state: idx === 12 ? "FL" : "FL",
    },
  ],
}));

const iterations = 5000;

console.log(
  `Running NPI pickBestSearchResult benchmark with ${iterations} iterations...`,
);

const start = performance.now();
for (let i = 0; i < iterations; i++) {
  __test.pickBestSearchResult(results, expected);
}
const end = performance.now();
console.log(
  `pickBestSearchResult: ${(end - start).toFixed(4)}ms (total), ${((end - start) / iterations).toFixed(6)}ms (avg)`,
);
