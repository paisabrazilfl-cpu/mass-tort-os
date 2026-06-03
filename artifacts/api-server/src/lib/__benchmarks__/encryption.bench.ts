import { encrypt, decrypt } from "../encryption.js";

const plaintext = "Hello World - performance benchmark test string";
const fieldName = "last_4_ssn";
const entityId = "12345";

// Mock environment for the benchmark if needed
process.env.ENCRYPTION_KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

const encrypted = encrypt(plaintext, fieldName, entityId);

const iterations = 100000;

console.log(`Running encryption benchmarks with ${iterations} iterations...`);

function benchmark(name: string, fn: () => void) {
  const start = performance.now();
  for (let i = 0; i < iterations; i++) {
    fn();
  }
  const end = performance.now();
  console.log(`${name}: ${(end - start).toFixed(4)}ms (total), ${((end - start) / iterations).toFixed(6)}ms (avg)`);
}

benchmark("encrypt", () => {
  encrypt(plaintext, fieldName, entityId);
});

benchmark("decrypt", () => {
  decrypt(encrypted, fieldName, entityId);
});
