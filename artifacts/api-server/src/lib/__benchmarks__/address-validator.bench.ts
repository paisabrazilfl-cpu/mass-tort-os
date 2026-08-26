import { validateAddress } from "../address-validator";

const iterations = 500000;

const sampleAddresses = [
  { street_address: "123 Main St", city: "New York", state: "NY", zip: "10001" },
  { street_address: "456 Market St", city: "San Francisco", state: "ca", zip: "94105-1234" },
  { street_address: "invalid", city: "x", state: "XX", zip: "abc" },
  { street_address: "789 Broadway Ave", city: "Chicago", state: "IL", zip: "60601" },
  { street_address: "asdf", city: "test", state: "NY", zip: "10001" },
];

console.log(`Running address validation benchmark with ${iterations} iterations...`);

const start = performance.now();
for (let i = 0; i < iterations; i++) {
  const addr = sampleAddresses[i % sampleAddresses.length];
  validateAddress(addr);
}
const end = performance.now();

const totalMs = end - start;
const avgMs = totalMs / iterations;

console.log(`validateAddress: ${totalMs.toFixed(4)}ms (total), ${avgMs.toFixed(6)}ms (avg)`);
