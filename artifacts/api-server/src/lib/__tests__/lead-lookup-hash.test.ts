import { describe, test } from "node:test";
import assert from "node:assert/strict";
import crypto from "crypto";
import { leadLookupHash } from "../lead-lookup-hash";

describe("leadLookupHash", () => {
  test("returns SHA-256 hash for valid input triple", () => {
    const hash = leadLookupHash("Camp Lejeune", "Jane.Doe@Example.com", "+1 (512) 555-0199");
    const expectedNorm = "camp lejeune|jane.doe@example.com|5125550199";
    const expectedHash = crypto.createHash("sha256").update(expectedNorm).digest("hex");
    assert.equal(hash, expectedHash);
  });

  test("handles different phone formatting identically", () => {
    const hash1 = leadLookupHash("Roundup", "test@domain.com", "(512) 555-0199");
    const hash2 = leadLookupHash("Roundup", "test@domain.com", "+1 512-555-0199");
    const hash3 = leadLookupHash("Roundup", "test@domain.com", "5125550199");
    assert.equal(hash1, hash2);
    assert.equal(hash2, hash3);
  });

  test("returns null when tortType is missing or empty or whitespace", () => {
    assert.equal(leadLookupHash(null, "a@b.com", "5125550199"), null);
    assert.equal(leadLookupHash("", "a@b.com", "5125550199"), null);
    assert.equal(leadLookupHash("   ", "a@b.com", "5125550199"), null);
  });

  test("returns null when email is missing or empty or whitespace", () => {
    assert.equal(leadLookupHash("Camp Lejeune", null, "5125550199"), null);
    assert.equal(leadLookupHash("Camp Lejeune", "", "5125550199"), null);
    assert.equal(leadLookupHash("Camp Lejeune", "   ", "5125550199"), null);
  });

  test("returns null when phone is missing, empty, or has fewer than 10 digits", () => {
    assert.equal(leadLookupHash("Camp Lejeune", "a@b.com", null), null);
    assert.equal(leadLookupHash("Camp Lejeune", "a@b.com", ""), null);
    assert.equal(leadLookupHash("Camp Lejeune", "a@b.com", "555-1234"), null);
  });
});
