import { encrypt, decrypt } from "../artifacts/api-server/src/lib/encryption";

// 32-byte key in hex (64 chars)
process.env.ENCRYPTION_KEY = "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff";

const iterations = 50000;
const plaintext = "This is a secret message for benchmarking encryption performance.";
const field = "phone";
const entityId = "12345";

console.log(`Running encryption benchmarks with ${iterations} iterations...`);

function benchmark(name: string, fn: () => void) {
  const start = performance.now();
  for (let i = 0; i < iterations; i++) {
    fn();
  }
  const end = performance.now();
  console.log(`${name}: ${(end - start).toFixed(4)}ms (total), ${((end - start) / iterations).toFixed(6)}ms (avg)`);
}

const ciphertextWithAAD = encrypt(plaintext, field, entityId);
const ciphertextNoAAD = encrypt(plaintext);

benchmark("encrypt (with AAD)", () => {
  encrypt(plaintext, field, entityId);
});

benchmark("decrypt (hit first AAD)", () => {
  decrypt(ciphertextWithAAD, field, entityId);
});

benchmark("decrypt (fallback to no AAD)", () => {
  decrypt(ciphertextNoAAD, field, entityId);
});

// Mock lead object for field encryption benchmark
const lead = {
  id: 12345,
  name: "John Doe",
  phone: "555-0199",
  phone_primary: "555-0100",
  email: "john@example.com",
  notes: "Some notes about the lead."
};

import { encryptLeadFields, decryptLeadFields } from "../artifacts/api-server/src/lib/encryption";

benchmark("encryptLeadFields", () => {
  encryptLeadFields(lead, "12345");
});

const encryptedLead = encryptLeadFields(lead, "12345");

benchmark("decryptLeadFields", () => {
  decryptLeadFields(encryptedLead, "12345");
});
