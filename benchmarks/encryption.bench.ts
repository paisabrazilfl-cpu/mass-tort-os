import {
  encrypt,
  decrypt,
  encryptLeadFields,
  decryptLeadFields,
} from "../artifacts/api-server/src/lib/encryption";

// Mock environment for the benchmark
process.env.ENCRYPTION_KEY =
  "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff";

const iterations = 10000;
const plaintext = "Hello, Bolt! This is a sensitive piece of information.";
const fieldName = "phone";
const entityId = "12345";

const ciphertext = encrypt(plaintext, fieldName, entityId);

const leadData = {
  first_name: "John",
  last_name: "Doe",
  phone: "555-0199",
  email: "john.doe@example.com",
  notes: "Wants to talk about Roundup case.",
};

console.log(`Running encryption benchmarks with ${iterations} iterations...`);

function benchmark(name: string, fn: () => void) {
  const start = performance.now();
  for (let i = 0; i < iterations; i++) {
    fn();
  }
  const end = performance.now();
  console.log(
    `${name}: ${(end - start).toFixed(4)}ms (total), ${((end - start) / iterations).toFixed(6)}ms (avg)`,
  );
}

benchmark("encrypt", () => {
  encrypt(plaintext, fieldName, entityId);
});

benchmark("decrypt (hit first AAD)", () => {
  decrypt(ciphertext, fieldName, entityId);
});

benchmark("decrypt (fallback to no AAD)", () => {
  // This will try field+entity, then field only, then no AAD.
  // Actually, if we pass wrong entityId, it will fallback.
  decrypt(ciphertext, fieldName, "wrong-id");
});

benchmark("encryptLeadFields", () => {
  encryptLeadFields(leadData, entityId);
});

benchmark("decryptLeadFields", () => {
  const encryptedLead = encryptLeadFields(leadData, entityId);
  decryptLeadFields(encryptedLead, entityId);
});

benchmark("decryptLeadFields (no encrypted fields)", () => {
  decryptLeadFields({ first_name: "John" }, entityId);
});
