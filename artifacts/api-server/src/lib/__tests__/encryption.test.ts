import { test, describe } from "node:test";
import assert from "node:assert";
import { encrypt, decrypt, encryptLeadFields, decryptLeadFields } from "../encryption.js";

// Mock environment for test isolation
process.env.ENCRYPTION_KEY = "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff";

describe("Encryption Module", () => {
  test("basic encrypt and decrypt", () => {
    const plain = "hello world";
    const cipher = encrypt(plain);
    assert.strictEqual(decrypt(cipher), plain);
  });

  test("encrypt and decrypt with AAD (field only)", () => {
    const plain = "secret data";
    const field = "phone";
    const cipher = encrypt(plain, field);
    assert.strictEqual(decrypt(cipher, field), plain);
    assert.strictEqual(decrypt(cipher, "wrong_field"), "[DECRYPTION_ERROR]");
  });

  test("encrypt and decrypt with AAD (field + entity)", () => {
    const plain = "top secret";
    const field = "last_4_ssn";
    const id = "lead_456";
    const cipher = encrypt(plain, field, id);
    assert.strictEqual(decrypt(cipher, field, id), plain);
    assert.strictEqual(decrypt(cipher, field, "wrong_id"), "[DECRYPTION_ERROR]");
  });

  test("decrypt fallback: field+entity -> field only", () => {
    const plain = "data";
    const field = "diagnosis";
    const cipher = encrypt(plain, field); // encrypted with field only
    assert.strictEqual(decrypt(cipher, field, "some_id"), plain); // fallback should work
  });

  test("decrypt fallback: any -> no AAD", () => {
    const plain = "data";
    const cipher = encrypt(plain); // no AAD
    assert.strictEqual(decrypt(cipher, "some_field", "some_id"), plain); // fallback to no AAD should work
  });

  test("encryptLeadFields lazy cloning", () => {
    const lead = { id: 1, name: "John", phone: "555-0199" };
    const encrypted = encryptLeadFields(lead, "1");
    assert.notStrictEqual(encrypted, lead);
    assert.ok(encrypted.phone.startsWith("enc:"));

    // Non-encrypted fields stay same
    assert.strictEqual(encrypted.name, "John");

    // Second call should return same object if nothing to encrypt
    const again = encryptLeadFields(encrypted, "1");
    assert.strictEqual(again, encrypted);
  });

  test("decryptLeadFields lazy cloning", () => {
    const lead = { id: 1, name: "John", phone: "555-0199" };
    const encrypted = encryptLeadFields(lead, "1");

    const decrypted = decryptLeadFields(encrypted, "1");
    assert.notStrictEqual(decrypted, encrypted);
    assert.strictEqual(decrypted.phone, "555-0199");

    // Second call should return same object if nothing to decrypt
    const again = decryptLeadFields(decrypted, "1");
    assert.strictEqual(again, decrypted);
  });

  test("decrypt malformed input", () => {
    assert.strictEqual(decrypt("not_encrypted"), "not_encrypted");
    assert.strictEqual(decrypt("enc:v1:0:invalid_base64_!@#"), "[DECRYPTION_ERROR]");
    assert.strictEqual(decrypt("enc:v1:0:"), "[DECRYPTION_ERROR]");
    assert.strictEqual(decrypt("enc:invalid"), "[DECRYPTION_ERROR]");
  });
});
