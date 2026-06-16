import { encrypt, decrypt, encryptLeadFields, decryptLeadFields } from "../artifacts/api-server/src/lib/encryption.js";

const plaintext = "555-0199";
const fieldName = "phone";
const entityId = "lead_123";

// Set a dummy encryption key for isolation
process.env.ENCRYPTION_KEY = "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff";

const ciphertext = encrypt(plaintext, fieldName, entityId);
const iterations = 10000;

const mockLead = {
  id: 123,
  first_name: "John",
  last_name: "Doe",
  phone: plaintext,
  phone_primary: plaintext,
  street_address: "123 Main St",
};

const encryptedLead = encryptLeadFields(mockLead, "123");

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

benchmark("decrypt (hit first AAD)", () => {
  decrypt(ciphertext, fieldName, entityId);
});

benchmark("decrypt (fallback AAD)", () => {
  decrypt(ciphertext, fieldName, "wrong_id");
});

benchmark("encryptLeadFields (lazy clone check)", () => {
  encryptLeadFields(mockLead, "123");
});

benchmark("decryptLeadFields (lazy clone check)", () => {
  decryptLeadFields(encryptedLead, "123");
});

benchmark("decryptLeadFields (no-op check)", () => {
  decryptLeadFields(mockLead, "123");
});
