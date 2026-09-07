import test from "node:test";
import assert from "node:assert/strict";
import crypto from "crypto";
import { leadLookupHash } from "../lead-lookup-hash";

test("leadLookupHash: computes expected SHA-256 hash for complete inputs", () => {
  const tort = "Roundup";
  const email = "John.Doe@example.com";
  const phone = "1-800-555-0199";

  const result = leadLookupHash(tort, email, phone);
  const expectedNorm = "roundup|john.doe@example.com|8005550199";
  const expectedHash = crypto.createHash("sha256").update(expectedNorm).digest("hex");

  assert.equal(result, expectedHash);
});

test("leadLookupHash: returns null when any argument is missing or empty", () => {
  assert.equal(leadLookupHash(null, "john@example.com", "5550199000"), null);
  assert.equal(leadLookupHash("Roundup", null, "5550199000"), null);
  assert.equal(leadLookupHash("Roundup", "john@example.com", null), null);

  assert.equal(leadLookupHash("", "john@example.com", "5550199000"), null);
  assert.equal(leadLookupHash("Roundup", "", "5550199000"), null);
  assert.equal(leadLookupHash("Roundup", "john@example.com", ""), null);

  assert.equal(leadLookupHash("  ", "john@example.com", "5550199000"), null);
  assert.equal(leadLookupHash("Roundup", "  ", "5550199000"), null);
  assert.equal(leadLookupHash("Roundup", "john@example.com", "12345"), null); // < 10 digits
});

test("leadLookupHash: trims whitespace and normalizes case", () => {
  const hash1 = leadLookupHash(" Roundup ", " John.Doe@Example.com ", "+1 (800) 555-0199 ");
  const hash2 = leadLookupHash("roundup", "john.doe@example.com", "8005550199");

  assert.equal(hash1, hash2);
  assert.notEqual(hash1, null);
});

test("leadLookupHash: takes last 10 digits across formatting characters", () => {
  const hash1 = leadLookupHash("Roundup", "john@example.com", "+1-800-555-0199");
  const hash2 = leadLookupHash("Roundup", "john@example.com", "(800) 555-0199");

  assert.equal(hash1, hash2);
});
