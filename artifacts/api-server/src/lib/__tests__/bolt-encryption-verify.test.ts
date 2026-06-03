import test from "node:test";
import assert from "node:assert";
import { encrypt, decrypt, encryptLeadFields, decryptLeadFields } from "../encryption.js";

// Mock environment
process.env.ENCRYPTION_KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

test("encryption and decryption with caching", () => {
  const plaintext = "Secret data";
  const fieldName = "last_4_ssn";
  const entityId = "123";

  const ciphertext = encrypt(plaintext, fieldName, entityId);
  assert.notStrictEqual(ciphertext, plaintext);
  assert.ok(ciphertext.startsWith("enc:v1:1:"));

  const decrypted = decrypt(ciphertext, fieldName, entityId);
  assert.strictEqual(decrypted, plaintext);
});

test("encryption and decryption without AAD", () => {
  const plaintext = "Secret data no AAD";
  const ciphertext = encrypt(plaintext);
  assert.ok(ciphertext.startsWith("enc:v1:0:"));

  const decrypted = decrypt(ciphertext);
  assert.strictEqual(decrypted, plaintext);
});

test("lead fields encryption and decryption", () => {
  const lead = {
    id: 123,
    last_4_ssn: "1234",
    name: "John Doe" // Not encrypted
  };

  const encryptedLead = encryptLeadFields(lead, "123");
  assert.ok(encryptedLead.last_4_ssn.startsWith("enc:"));
  assert.strictEqual(encryptedLead.name, "John Doe");

  const decryptedLead = decryptLeadFields(encryptedLead, "123");
  assert.strictEqual(decryptedLead.last_4_ssn, "1234");
  assert.strictEqual(decryptedLead.name, "John Doe");
});
