import crypto from "crypto";
import {
  encrypt,
  decrypt,
  decryptLeadArray,
  ENCRYPTED_FIELDS,
} from "../encryption";

// Mock environment variables for benchmark
process.env.ENCRYPTION_KEY =
  "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff";

const iterations = 10000;
const leadCount = 100;

console.log(
  `Running encryption benchmarks with ${iterations} iterations and ${leadCount} leads...`,
);

const plainText = "Some sensitive data to encrypt and decrypt";
const encryptedNoAAD = encrypt(plainText);
const encryptedWithAAD = encrypt(plainText, "last_4_ssn", "12345");

const leads = Array.from({ length: leadCount }, (_, i) => {
  const lead: Record<string, any> = {
    id: i,
    name: `Lead ${i}`,
    email: `lead${i}@example.com`,
  };
  // Populate some encrypted fields
  ENCRYPTED_FIELDS.slice(0, 5).forEach((field) => {
    lead[field] = encrypt(`Value for ${field} in lead ${i}`, field, String(i));
  });
  return lead;
});

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

benchmark("decrypt (no AAD)", () => {
  decrypt(encryptedNoAAD);
});

benchmark("decrypt (with AAD)", () => {
  decrypt(encryptedWithAAD, "last_4_ssn", "12345");
});

// For decryptLeadArray, we do fewer iterations because it's much heavier
const arrayIterations = 100;
console.log(
  `Running decryptLeadArray benchmark with ${arrayIterations} iterations...`,
);

const startArray = performance.now();
for (let i = 0; i < arrayIterations; i++) {
  decryptLeadArray(leads);
}
const endArray = performance.now();
console.log(
  `decryptLeadArray: ${(endArray - startArray).toFixed(4)}ms (total), ${((endArray - startArray) / arrayIterations).toFixed(6)}ms (avg)`,
);
