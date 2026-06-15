import { encrypt, decrypt, encryptLeadFields, decryptLeadFields } from "../artifacts/api-server/src/lib/encryption.js";

const plaintext = "555-0199";
const fieldName = "phone";
const entityId = "12345";

// Setup environment for benchmark
process.env.ENCRYPTION_KEY = "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff";

const ciphertext = encrypt(plaintext, fieldName, entityId);

const iterations = 10000;

console.log(`Running encryption benchmarks with ${iterations} iterations...`);

function benchmark(name: string, fn: () => void) {
  const start = performance.now();
  for (let i = 0; i < iterations; i++) {
    fn();
  }
  const end = performance.now();
  console.log(`${name}: ${(end - start).toFixed(4)}ms (total), ${((end - start) / iterations).toFixed(6)}ms (avg)`);
}

benchmark("decrypt (hit first AAD)", () => {
  decrypt(ciphertext, fieldName, entityId);
});

benchmark("decrypt (miss first AAD, hit second)", () => {
  decrypt(ciphertext, fieldName, undefined);
});

const leadData = {
    first_name: "John",
    last_name: "Doe",
    phone: "555-0199",
    phone_primary: "555-0100",
    email: "john@example.com",
    notes: "Some sensitive notes"
};

benchmark("encryptLeadFields", () => {
    encryptLeadFields(leadData, entityId);
});

const encryptedLead = encryptLeadFields(leadData, entityId);

benchmark("decryptLeadFields", () => {
    decryptLeadFields(encryptedLead, entityId);
});

benchmark("decryptLeadFields (no encrypted fields)", () => {
    decryptLeadFields({ name: "plain" }, entityId);
});
