import { encrypt, decrypt, decryptLeadArray } from "../encryption.js";

// 32 bytes (64 hex chars)
process.env.ENCRYPTION_KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

const iterations = 100000;
const leadId = 12345;
const fieldName = "phone";
const plaintext = "1234567890";

const encryptedNoAAD = encrypt(plaintext);
const encryptedWithAAD = encrypt(plaintext, fieldName, String(leadId));

console.log(`Running encryption benchmarks with ${iterations} iterations...`);

function benchmark(name: string, fn: () => void) {
  const start = performance.now();
  for (let i = 0; i < iterations; i++) {
    fn();
  }
  const end = performance.now();
  console.log(`${name}: ${(end - start).toFixed(4)}ms (total), ${((end - start) / iterations).toFixed(6)}ms (avg)`);
}

benchmark("decrypt (no AAD)", () => {
  decrypt(encryptedNoAAD);
});

benchmark("decrypt (with AAD)", () => {
  decrypt(encryptedWithAAD, fieldName, String(leadId));
});

const idStr = String(leadId);
const sampleLead = {
  id: leadId,
  phone: encrypt("5551234567", "phone", idStr),
  phone_primary: encrypt("5557654321", "phone_primary", idStr),
  notes: encrypt("Some notes", "notes", idStr),
  last_4_ssn: encrypt("1234", "last_4_ssn", idStr),
  date_of_birth: encrypt("1990-01-01", "date_of_birth", idStr),
  other: "not encrypted"
};

const leads = Array(10).fill(sampleLead);

// For decryptLeadArray, 100k iterations might be too slow, let's do 10k
const iterationsArray = 10000;
console.log(`Running decryptLeadArray benchmark with ${iterationsArray} iterations...`);

const startArr = performance.now();
for (let i = 0; i < iterationsArray; i++) {
  decryptLeadArray(leads);
}
const endArr = performance.now();
console.log(`decryptLeadArray (10 leads): ${(endArr - startArr).toFixed(4)}ms (total), ${((endArr - startArr) / iterationsArray).toFixed(6)}ms (avg)`);
