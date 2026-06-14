import { strict as assert } from "node:assert";
import test from "node:test";
import {
  encrypt,
  decrypt,
  encryptLeadFields,
  decryptLeadFields,
} from "../encryption.js";

// Mock environment for the test
process.env.ENCRYPTION_KEY =
  "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff";

test("encrypt and decrypt basic", () => {
  const plaintext = "Hello World";
  const encrypted = encrypt(plaintext);
  assert.notEqual(encrypted, plaintext);
  assert.ok(encrypted.startsWith("enc:v1:0:"));

  const decrypted = decrypt(encrypted);
  assert.equal(decrypted, plaintext);
});

test("encrypt and decrypt with AAD", () => {
  const plaintext = "Secret Message";
  const fieldName = "phone";
  const entityId = "lead_123";

  const encrypted = encrypt(plaintext, fieldName, entityId);
  assert.ok(encrypted.startsWith("enc:v1:1:"));

  // Decrypt with exact AAD
  assert.equal(decrypt(encrypted, fieldName, entityId), plaintext);

  // Decrypt with fallback to field only (this will FAIL because it was encrypted with entityId)
  // AES-GCM requires the EXACT AAD.
  assert.equal(decrypt(encrypted, fieldName, "wrong_id"), "[DECRYPTION_ERROR]");

  // Encrypt with field only
  const encryptedFieldOnly = encrypt(plaintext, fieldName);
  // Decrypt with field + entityId should succeed due to fallback to field only
  assert.equal(decrypt(encryptedFieldOnly, fieldName, "any_id"), plaintext);
});

test("decrypt legacy header", () => {
  const versioned = encrypt("test", "field", "id");
  assert.equal(decrypt(versioned, "field", "id"), "test");
});

test("encryptLeadFields lazy cloning", () => {
  const data = { name: "John", age: 30 };
  const result = encryptLeadFields(data);

  // In the optimized version, this should be strictly equal
  // In the original version, this was NOT strictly equal
  assert.strictEqual(result, data);

  const dataWithSensitive = { name: "John", phone: "1234567890" };
  const result2 = encryptLeadFields(dataWithSensitive);

  assert.notStrictEqual(result2, dataWithSensitive);
  assert.ok(result2.phone.startsWith("enc:"));
});

test("decryptLeadFields lazy cloning", () => {
  const data = { name: "John", age: 30 };
  const result = decryptLeadFields(data);

  assert.strictEqual(result, data);

  const encryptedPhone = encrypt("1234567890", "phone");
  const dataWithEncrypted = { name: "John", phone: encryptedPhone };
  const result2 = decryptLeadFields(dataWithEncrypted, undefined);

  assert.notStrictEqual(result2, dataWithEncrypted);
  assert.equal(result2.phone, "1234567890");
});

test("decrypt invalid input", () => {
  assert.equal(decrypt(""), "");
  assert.equal(decrypt("not encrypted"), "not encrypted");
  assert.equal(decrypt("enc:v1:0:invalid-base64!!!"), "[DECRYPTION_ERROR]");
});
