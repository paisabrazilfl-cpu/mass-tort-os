import { test } from "node:test";
import assert from "node:assert";
import { encrypt, decrypt } from "../encryption";

test("Encryption: versioned format with colons in payload", () => {
  const plaintext = "user:password:something:else";
  const encrypted = encrypt(plaintext, "testField", "testEntity");

  // Format is enc:v1:1:combinedBase64
  assert.ok(encrypted.indexOf("enc:v1:1:") === 0);

  const decrypted = decrypt(encrypted, "testField", "testEntity");
  assert.strictEqual(decrypted, plaintext);
});

test("Encryption: basic encrypt/decrypt", () => {
  const plaintext = "hello world";
  const encrypted = encrypt(plaintext);
  const decrypted = decrypt(encrypted);
  assert.strictEqual(decrypted, plaintext);
});

test("Encryption: AAD mismatch fails", () => {
  const plaintext = "secret data";
  const encrypted = encrypt(plaintext, "fieldA");
  // Decrypting with wrong field name should return error if we enforced it,
  // but decrypt() has fallback to no-AAD.
  // Actually, encrypt(plaintext, "fieldA") sets hasAADFlag=1.
  // decrypt() tries: 1. field+entity, 2. field only, 3. no AAD.
  const decrypted = decrypt(encrypted, "fieldB");
  // Since we don't have the "fieldA" in candidates, it tries "fieldB" (fail), then no-AAD (fail).
  assert.strictEqual(decrypted, "[DECRYPTION_ERROR]");
});
