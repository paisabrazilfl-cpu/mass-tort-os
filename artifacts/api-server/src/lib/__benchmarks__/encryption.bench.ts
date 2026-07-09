import { encryptLeadFields, decryptLeadFields, ENCRYPTED_FIELDS } from "../encryption";
import { logger } from "../logger";

logger.level = "silent";

const iterations = 10000;

// Data that is already encrypted/decrypted, so no changes needed
const alreadyProcessedData = {
  id: 1,
  first_name: "John",
  last_name: "Doe",
  email: "john@example.com",
  ...Object.fromEntries(ENCRYPTED_FIELDS.map(f => [f, "enc:v1:0:payload"]))
};

// Data that needs encryption
const needsEncryptionData = {
  id: 1,
  first_name: "John",
  last_name: "Doe",
  email: "john@example.com",
  ...Object.fromEntries(ENCRYPTED_FIELDS.map(f => [f, "plain text value"]))
};

// Data that needs decryption
const needsDecryptionData = {
  id: 1,
  first_name: "John",
  last_name: "Doe",
  email: "john@example.com",
  ...Object.fromEntries(ENCRYPTED_FIELDS.map(f => [f, "enc:v1:0:c29tZSB2YWx1ZQ=="])) // "some value" in base64
};

console.log(`Running Encryption benchmarks with ${iterations} iterations...`);

function benchmark(name: string, fn: () => void) {
  const start = performance.now();
  for (let i = 0; i < iterations; i++) {
    fn();
  }
  const end = performance.now();
  console.log(`${name}: ${(end - start).toFixed(4)}ms (total), ${((end - start) / iterations).toFixed(6)}ms (avg)`);
}

// Setup environment for encryption
process.env.ENCRYPTION_KEY = "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f";

benchmark("encryptLeadFields (already encrypted)", () => {
  encryptLeadFields(alreadyProcessedData, "1");
});

benchmark("encryptLeadFields (needs encryption)", () => {
  encryptLeadFields(needsEncryptionData, "1");
});

benchmark("decryptLeadFields (already plain)", () => {
  decryptLeadFields(needsEncryptionData, "1");
});

benchmark("decryptLeadFields (needs decryption)", () => {
  decryptLeadFields(needsDecryptionData, "1");
});
