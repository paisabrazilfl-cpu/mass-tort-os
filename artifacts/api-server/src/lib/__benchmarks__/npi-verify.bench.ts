import { __test, ExpectedProvider } from "../npi-verify";

const results = [
  {
    number: "1234567890",
    basic: {
      first_name: "Micah",
      last_name: "Edwin",
      credential: "MD",
    },
    addresses: [
      {
        address_purpose: "LOCATION",
        city: "Seattle",
        state: "WA",
      },
    ],
  },
  {
    number: "9876543210",
    basic: {
      organization_name: "Swedish Medical Center",
    },
    addresses: [
      {
        address_purpose: "LOCATION",
        city: "Seattle",
        state: "WA",
      },
    ],
  },
  {
    number: "1112223334",
    basic: {
      first_name: "John",
      last_name: "Smith",
      credential: "DO",
    },
    addresses: [
      {
        address_purpose: "MAILING",
        city: "Tacoma",
        state: "WA",
      },
    ],
  },
];

const expected: ExpectedProvider = {
  name: "Dr. Micah Edwin, MD",
  city: "Seattle",
  state: "WA",
};

const iterations = 10000;

console.log(`Running NPI search benchmarks with ${iterations} iterations...`);

const start = performance.now();
for (let i = 0; i < iterations; i++) {
  __test.pickBestSearchResult(results, expected);
}
const end = performance.now();

console.log(`pickBestSearchResult: ${(end - start).toFixed(4)}ms (total), ${((end - start) / iterations).toFixed(6)}ms (avg)`);
