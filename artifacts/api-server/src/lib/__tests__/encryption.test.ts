import { test, describe } from "node:test";
import assert from "node:assert";
import { encrypt, decrypt, encryptLeadFields, decryptLeadFields } from "../encryption.js";

// Setup environment for encryption
process.env.ENCRYPTION_KEY_V1 = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

describe("Encryption", () => {
  test("encrypt and decrypt should be inverse", () => {
    const plaintext = "hello world";
    const field = "phone";
    const entityId = "123";

    const ciphertext = encrypt(plaintext, field, entityId);
    assert.ok(ciphertext.startsWith("enc:v1:1:"));

    const decrypted = decrypt(ciphertext, field, entityId);
    assert.strictEqual(decrypted, plaintext);
  });

  test("decrypt should support AAD fallback (field + entity -> field only)", () => {
    const plaintext = "hello world";
    const field = "phone";
    const entityId = "123";

    // Encrypted with field only
    const ciphertext = encrypt(plaintext, field);

    // Decrypt with field + entity (should hit fallback)
    const decrypted = decrypt(ciphertext, field, entityId);
    assert.strictEqual(decrypted, plaintext);
  });

  test("decrypt should support AAD fallback (field -> no AAD)", () => {
    const plaintext = "hello world";
    const field = "phone";

    // Encrypted with NO AAD (legacy style or explicitly none)
    // We can simulate this by manually creating a v1:0: ciphertext if we wanted,
    // but encrypt(plaintext) without field does this.
    const ciphertext = encrypt(plaintext);
    assert.ok(ciphertext.startsWith("enc:v1:0:"));

    const decrypted = decrypt(ciphertext, field);
    assert.strictEqual(decrypted, plaintext);
  });

  test("encryptLeadFields should implement lazy cloning", () => {
    const data = { name: "John", other: "stuff" };
    const result = encryptLeadFields(data);

    // No encrypted fields in 'data', should return same object reference
    assert.strictEqual(result, data);

    const dataWithSecret = { ...data, phone: "1234567890" };
    const result2 = encryptLeadFields(dataWithSecret);

    // 'phone' is in ENCRYPTED_FIELDS, should return new object
    assert.notStrictEqual(result2, dataWithSecret);
    assert.ok(result2.phone.startsWith("enc:"));
    assert.strictEqual(result2.name, "John");
  });

  test("decryptLeadFields should implement lazy cloning", () => {
    const data = { name: "John", other: "stuff" };
    const result = decryptLeadFields(data);

    // No encrypted fields, should return same object reference
    assert.strictEqual(result, data);

    const encryptedPhone = encrypt("1234567890", "phone");
    const dataWithSecret = { ...data, phone: encryptedPhone };
    const result2 = decryptLeadFields(dataWithSecret, undefined);

    assert.notStrictEqual(result2, dataWithSecret);
    assert.strictEqual(result2.phone, "1234567890");
    assert.strictEqual(result2.name, "John");
  });
});
