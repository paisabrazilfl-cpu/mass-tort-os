import { encrypt, decrypt, encryptLeadFields, decryptLeadFields } from "../encryption";
import { logger } from "../logger";

// Suppress logs during benchmark
logger.level = "silent";

// Mock environment for keys
process.env.ENCRYPTION_KEY_V1 = "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f";

const plaintext = "sensitive data 123";
const entityId = "lead_123";
const notesCiphertext = encrypt(plaintext, "notes", entityId);
const diagCiphertext = encrypt(plaintext, "diagnosis", entityId);

const iterations = 50000;

console.log(`Running benchmarks with ${iterations} iterations...`);

function benchmark(name: string, fn: () => void) {
  const start = performance.now();
  for (let i = 0; i < iterations; i++) {
    fn();
  }
  const end = performance.now();
  console.log(`${name}: ${(end - start).toFixed(4)}ms (total), ${((end - start) / iterations).toFixed(6)}ms (avg)`);
}

benchmark("decrypt (versioned)", () => {
  decrypt(notesCiphertext, "notes", entityId);
});

const dataNoOp = {
  id: 123,
  first_name: "John",
  last_name: "Smith",
  email: "john@example.com",
};

benchmark("encryptLeadFields (no-op)", () => {
  encryptLeadFields(dataNoOp, entityId);
});

benchmark("decryptLeadFields (no-op)", () => {
  decryptLeadFields(dataNoOp, entityId);
});

const dataMixed = {
  id: 123,
  notes: plaintext,
  phone: "555-0199",
  diagnosis: diagCiphertext,
};

benchmark("encryptLeadFields (mixed)", () => {
  encryptLeadFields(dataMixed, entityId);
});

benchmark("decryptLeadFields (mixed)", () => {
  decryptLeadFields(dataMixed, entityId);
});
