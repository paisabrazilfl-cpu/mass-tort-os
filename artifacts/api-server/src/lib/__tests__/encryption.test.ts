import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { encrypt, decrypt, encryptLeadFields, decryptLeadFields } from "../encryption.ts";

const key = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
process.env.ENCRYPTION_KEY = key;
process.env.ENCRYPTION_KEY_V1 = key;

describe("Encryption", () => {
  test("encrypt and decrypt with AAD", () => {
    const plaintext = "Hello World";
    const fieldName = "phone";
    const entityId = "123";
    const ciphertext = encrypt(plaintext, fieldName, entityId);
    assert.ok(ciphertext.startsWith("enc:v1:1:"));
    const decrypted = decrypt(ciphertext, fieldName, entityId);
    assert.equal(decrypted, plaintext);
  });

  test("decrypt fallback to field-only AAD", () => {
    const plaintext = "Hello World";
    const fieldName = "phone";
    const ciphertext = encrypt(plaintext, fieldName);
    assert.ok(ciphertext.startsWith("enc:v1:1:"));
    const decrypted = decrypt(ciphertext, fieldName, "any-id");
    assert.equal(decrypted, plaintext);
  });

  test("decrypt fallback to no AAD", () => {
    const plaintext = "Hello World";
    const ciphertext = encrypt(plaintext);
    assert.ok(ciphertext.startsWith("enc:v1:0:"));
    const decrypted = decrypt(ciphertext, "some-field", "some-id");
    assert.equal(decrypted, plaintext);
  });

  test("encryptLeadFields lazy cloning", () => {
    const data = { name: "John", phone: "1234567890" };
    const encrypted = encryptLeadFields(data);
    assert.notEqual(encrypted, data);
    assert.ok(encrypted.phone.startsWith("enc:"));

    const secondEnc = encryptLeadFields(encrypted);
    assert.equal(secondEnc, encrypted, "Should return same reference if already encrypted");
  });

  test("decryptLeadFields lazy cloning", () => {
    const plaintext = "1234567890";
    const ciphertext = encrypt(plaintext, "phone");
    const data = { name: "John", phone: ciphertext };
    const decrypted = decryptLeadFields(data, "phone");
    assert.notEqual(decrypted, data);
    assert.equal(decrypted.phone, plaintext);

    const secondDec = decryptLeadFields(decrypted, "phone");
    assert.equal(secondDec, decrypted, "Should return same reference if no encrypted fields found");
  });
});
