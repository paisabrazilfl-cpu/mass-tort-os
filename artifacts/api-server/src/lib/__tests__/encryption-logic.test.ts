import { test } from "node:test";
import assert from "node:assert";
import { encrypt, decrypt } from "../encryption.js";

test("encryption and decryption with various AAD configurations", () => {
  const plaintext = "Hello, Bolt!";
  const fieldName = "phone";
  const entityId = "lead_123";

  // 1. Full AAD (field + entity)
  const cypher1 = encrypt(plaintext, fieldName, entityId);
  assert.notStrictEqual(cypher1, plaintext);
  assert.strictEqual(decrypt(cypher1, fieldName, entityId), plaintext);

  // 2. Field-only AAD
  const cypher2 = encrypt(plaintext, fieldName);
  assert.strictEqual(decrypt(cypher2, fieldName), plaintext);
  assert.strictEqual(
    decrypt(cypher2, fieldName, "different_entity"),
    plaintext,
  );

  // 3. No AAD
  const cypher3 = encrypt(plaintext);
  assert.strictEqual(decrypt(cypher3), plaintext);
  assert.strictEqual(decrypt(cypher3, "any_field"), plaintext);
});

test("legacy and malformed ciphertexts", () => {
  assert.strictEqual(decrypt("plain text"), "plain text");
  assert.strictEqual(decrypt(""), "");
  assert.strictEqual(decrypt(null as any), null as any);

  // Legacy "enc:" prefix without versioning
  const legacyEnc = "enc:somerandompayload";
  assert.strictEqual(decrypt(legacyEnc), "[DECRYPTION_ERROR]");
});

test("versioned header parsing logic", () => {
  const plaintext = "Secret message";
  const ciphertext = encrypt(plaintext, "notes", "456");

  // ciphertext should look like "enc:v1:1:base64..."
  assert.ok(ciphertext.startsWith("enc:v1:1:"));

  const decrypted = decrypt(ciphertext, "notes", "456");
  assert.strictEqual(decrypted, plaintext);
});
