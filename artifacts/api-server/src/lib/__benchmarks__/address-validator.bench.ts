import { validateAddress } from "../address-validator";

const testAddresses = [
  {
    street_address: "123 Main St",
    city: "Los Angeles",
    state: "CA",
    zip: "90001",
  },
  {
    street_address: "456 Oak Avenue Apt 4B",
    city: "New York",
    state: "ny",
    zip: "10001-1234",
  },
  {
    street_address: "test",
    city: "na",
    state: "XX",
    zip: "000000",
  },
  {
    street_address: "",
    city: "",
    state: "",
    zip: "",
  },
  {
    street_address: "789 Market Street",
    city: "San Francisco",
    state: "CA",
    zip: "94103",
  },
];

const iterations = 200000;

console.log(`Running address-validator benchmark with ${iterations} calls...`);

const start = performance.now();
for (let i = 0; i < iterations; i++) {
  const addr = testAddresses[i % testAddresses.length]!;
  validateAddress(addr);
}
const end = performance.now();
const duration = end - start;
console.log(`Total duration: ${duration.toFixed(2)}ms`);
console.log(`Average latency per call: ${(duration / (iterations)).toFixed(6)}ms`);
