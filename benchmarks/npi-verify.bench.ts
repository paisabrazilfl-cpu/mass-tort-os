import { __test } from "../artifacts/api-server/src/lib/npi-verify";

const { pickBestSearchResult } = __test;

const expected = {
  name: "Dr. Micah Edwin, MD",
  organization: "Main Street Medical",
  city: "San Francisco",
  state: "CA",
};

const results = [
  {
    number: "1234567890",
    basic: {
      first_name: "Micah",
      last_name: "Edwin",
      organization_name: "Main Street Medical",
    },
    addresses: [
      {
        address_purpose: "LOCATION",
        city: "San Francisco",
        state: "CA",
      },
    ],
  },
  {
    number: "1234567891",
    basic: {
      first_name: "Michael",
      last_name: "Edwins",
      organization_name: "Main St Medical",
    },
    addresses: [
      {
        address_purpose: "LOCATION",
        city: "San Fran",
        state: "CA",
      },
    ],
  },
  {
    number: "1234567892",
    basic: {
      first_name: "M",
      last_name: "Edwin",
      organization_name: "Medical Center",
    },
    addresses: [
      {
        address_purpose: "LOCATION",
        city: "Los Angeles",
        state: "CA",
      },
    ],
  },
  {
    number: "1234567893",
    basic: {
      first_name: "Micah",
      last_name: "E",
      organization_name: "Health Clinic",
    },
    addresses: [
      {
        address_purpose: "LOCATION",
        city: "San Francisco",
        state: "CA",
      },
    ],
  },
  {
    number: "1234567894",
    basic: {
      first_name: "John",
      last_name: "Doe",
      organization_name: "Random Org",
    },
    addresses: [
      {
        address_purpose: "LOCATION",
        city: "New York",
        state: "NY",
      },
    ],
  },
];

// Imperfect results that won't trigger early break
const imperfectResults = results.slice(1).map(r => ({...r}));
const manyImperfect = [...imperfectResults, ...imperfectResults, ...imperfectResults, ...imperfectResults, ...imperfectResults]; // 20 results

const manyResults = [...results, ...results, ...results, ...results]; // includes perfect match

const iterations = 10000;

console.log(`Running NPI verify benchmark with ${iterations} iterations...`);

function benchmark(name: string, fn: () => void) {
  const start = performance.now();
  for (let i = 0; i < iterations; i++) {
    fn();
  }
  const end = performance.now();
  console.log(`${name}: ${(end - start).toFixed(4)}ms (total), ${((end - start) / iterations).toFixed(6)}ms (avg)`);
}

benchmark("pickBestSearchResult (20 results, first is perfect)", () => {
  pickBestSearchResult(manyResults, expected);
});

benchmark("pickBestSearchResult (20 results, no perfect match)", () => {
  pickBestSearchResult(manyImperfect, expected);
});
