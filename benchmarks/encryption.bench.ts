import { encrypt, decrypt, encryptLeadFields, decryptLeadFields } from "../artifacts/api-server/src/lib/encryption.js";

const iterations = 10000;
const key = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
process.env.ENCRYPTION_KEY = key;

const plaintext = "5125551234";
const fieldName = "phone";
const entityId = "123";

const encrypted = encrypt(plaintext, fieldName, entityId);

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
  decrypt(encrypted, fieldName, entityId);
});

benchmark("decrypt (hit fallback AAD)", () => {
  // If we don't pass entityId, it fails field+entity, then tries field only.
  // Our encrypted value was field+entity, so it should actually FAIL field-only
  // and then try 'no AAD' and then fail both.
  // Wait, let's make one that actually hits fallback.
  const encryptedFieldOnly = encrypt(plaintext, fieldName, undefined);
  decrypt(encryptedFieldOnly, fieldName, "999");
  // Should try (field:999) -> fail, (field:undefined) -> success.
});

const lead = {
  name: "John Doe",
  phone: plaintext,
  email: "john@example.com",
};

benchmark("encryptLeadFields (actually encrypts)", () => {
  encryptLeadFields(lead, entityId);
});

benchmark("encryptLeadFields (noop - already encrypted)", () => {
  const encLead = encryptLeadFields(lead, entityId);
  encryptLeadFields(encLead, entityId);
});

const encryptedLead = encryptLeadFields(lead, entityId);

benchmark("decryptLeadFields (actually decrypts)", () => {
  decryptLeadFields(encryptedLead, entityId);
});

benchmark("decryptLeadFields (noop - already plaintext)", () => {
  decryptLeadFields(lead, entityId);
});
