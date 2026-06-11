import { encrypt, decrypt } from "../artifacts/api-server/src/lib/encryption.ts";

const key = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
process.env.ENCRYPTION_KEY = key;
process.env.ENCRYPTION_KEY_V1 = key;
process.env.LOG_LEVEL = "silent";

const iterations = 10000;
const plaintext = "Hello, Bolt! This is a test of the encryption system.";
const fieldName = "phone";
const entityId = "12345";

const ciphertext = encrypt(plaintext, fieldName, entityId);

function benchmark(name: string, fn: () => void) {
  const start = performance.now();
  for (let i = 0; i < iterations; i++) {
    fn();
  }
  const end = performance.now();
  console.log(`${name}: ${(end - start).toFixed(4)}ms (total), ${((end - start) / iterations).toFixed(6)}ms (avg)`);
}

console.log(`Running encryption benchmarks with ${iterations} iterations...`);

benchmark("encrypt", () => {
  encrypt(plaintext, fieldName, entityId);
});

benchmark("decrypt (hit first AAD)", () => {
  decrypt(ciphertext, fieldName, entityId);
});

benchmark("decrypt (fallback to second AAD)", () => {
  decrypt(ciphertext, fieldName);
});

benchmark("decrypt (fallback to no AAD)", () => {
  decrypt(ciphertext, "wrong_field");
});
