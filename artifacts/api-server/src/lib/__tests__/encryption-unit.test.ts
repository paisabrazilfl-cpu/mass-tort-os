import assert from "node:assert";
import { test } from "node:test";
import { encrypt, decrypt, encryptLeadFields, decryptLeadFields, getCurrentKeyVersion } from "../encryption";

// Mock environment for keys
process.env.ENCRYPTION_KEY_V1 = "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f";

test("basic encryption and decryption", () => {
  const plaintext = "hello world";
  const field = "notes";
  const id = "lead_1";

  const ciphertext = encrypt(plaintext, field, id);
  assert.ok(ciphertext.startsWith("enc:v1:1:"));

  const decrypted = decrypt(ciphertext, field, id);
  assert.strictEqual(decrypted, plaintext);
});

test("decryption fallbacks", () => {
  const plaintext = "fallback test";
  const field = "notes";
  const id = "lead_2";

  // 1. Encrypted with field only, but decrypted with field and id
  const cipherFieldOnly = encrypt(plaintext, field, undefined);
  // Should fallback from (field+id) to (field)
  assert.strictEqual(decrypt(cipherFieldOnly, field, id), plaintext);

  // 2. Encrypted with no AAD, but decrypted with field and id
  const cipherNoAAD = encrypt(plaintext, undefined, undefined);
  // Should fallback from (field+id) to (field) to (no AAD)
  assert.strictEqual(decrypt(cipherNoAAD, field, id), plaintext);

  // 3. Encrypted with field and id, MUST be decrypted with field and id
  const cipherFull = encrypt(plaintext, field, id);
  assert.strictEqual(decrypt(cipherFull, field, id), plaintext);
  // It should NOT decrypt if the AAD is wrong or missing
  assert.strictEqual(decrypt(cipherFull, field, "wrong_id"), "[DECRYPTION_ERROR]");
  assert.strictEqual(decrypt(cipherFull, undefined, undefined), "[DECRYPTION_ERROR]");
});

test("lazy cloning in encryptLeadFields", () => {
  const data = { id: 1, name: "John" };
  const result = encryptLeadFields(data, "1");
  assert.strictEqual(result, data, "Should not clone if no encrypted fields present");

  const dataWithEnc = { id: 2, notes: "some notes" };
  const result2 = encryptLeadFields(dataWithEnc, "2");
  assert.notStrictEqual(result2, dataWithEnc, "Should clone if field encrypted");
  assert.ok(result2.notes.startsWith("enc:"));
});

test("lazy cloning in decryptLeadFields", () => {
  const data = { id: 1, name: "John" };
  const result = decryptLeadFields(data, "1");
  assert.strictEqual(result, data, "Should not clone if no encrypted fields present");

  const ciphertext = encrypt("secret", "notes", "2");
  const dataWithCipher = { id: 2, notes: ciphertext };
  const result2 = decryptLeadFields(dataWithCipher, "2");
  assert.notStrictEqual(result2, dataWithCipher, "Should clone if field decrypted");
  assert.strictEqual(result2.notes, "secret");

  const dataWithPlain = { id: 3, notes: "plain" };
  const result3 = decryptLeadFields(dataWithPlain, "3");
  assert.strictEqual(result3, dataWithPlain, "Should not clone if field already plain");
});

test("legacy format support", () => {
  // Legacy format is just enc:<payload> (no vN:AAD:)
  // We need a way to generate it or mock it.
  // The current encrypt() doesn't generate it.
  // From code: payload = ciphertext.slice(4);

  // Let's assume a ciphertext that didn't have v in it.
  // Actually, tryDecryptWithAAD uses base64 decoding on payload.
  const legacyPayload = Buffer.from("legacy").toString("base64"); // This won't actually decrypt but let's test the parsing
  const legacyCiphertext = "enc:" + legacyPayload;

  // It will try to decrypt and fail (returning [DECRYPTION_ERROR]), but shouldn't crash
  const result = decrypt(legacyCiphertext, "notes", "1");
  assert.strictEqual(result, "[DECRYPTION_ERROR]");
});
