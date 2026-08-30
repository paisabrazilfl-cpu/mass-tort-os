import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { validateEmail } from "../email-validator";

describe("email-validator", () => {
  it("validates valid email address", () => {
    const res = validateEmail("john.doe@gmail.com");
    assert.equal(res.valid, true);
    assert.equal(res.errors.length, 0);
    assert.equal(res.suggestion, undefined);
  });

  it("handles missing or non-string email", () => {
    assert.deepEqual(validateEmail(""), { valid: false, errors: ["MISSING_EMAIL"] });
    assert.deepEqual(validateEmail(null as unknown as string), { valid: false, errors: ["MISSING_EMAIL"] });
    assert.deepEqual(validateEmail(123 as unknown as string), { valid: false, errors: ["MISSING_EMAIL"] });
  });

  it("handles invalid RFC format", () => {
    const res = validateEmail("invalid-email");
    assert.equal(res.valid, false);
    assert.deepEqual(res.errors, ["INVALID_RFC_FORMAT"]);
  });

  it("detects exact typo domain and provides suggestion", () => {
    const res = validateEmail("jane.smith@gnail.com");
    assert.equal(res.valid, true); // Advisory code TYPO_DOMAIN_DETECTED is not hard failure
    assert.ok(res.errors.includes("TYPO_DOMAIN_DETECTED"));
    assert.equal(res.suggestion, "jane.smith@gmail.com");
  });

  it("detects fuzzy typo domain and provides suggestion", () => {
    const res = validateEmail("user@gmai.com");
    assert.equal(res.valid, true); // Advisory code is not hard failure
    assert.ok(res.errors.includes("TYPO_DOMAIN_DETECTED") || res.errors.includes("LIKELY_TYPO_DOMAIN"));
    assert.equal(res.suggestion, "user@gmail.com");
  });

  it("detects malformed TLD", () => {
    const res = validateEmail("alice@yahoo.con");
    assert.equal(res.valid, false); // Advisory code + MALFORMED_TLD
    assert.ok(res.errors.includes("MALFORMED_TLD"));
    assert.equal(res.suggestion, "alice@yahoo.com");
  });

  it("detects disposable email domain", () => {
    const res = validateEmail("user@tempmail.com");
    assert.equal(res.valid, false);
    assert.ok(res.errors.includes("DISPOSABLE_EMAIL"));
  });

  it("detects suspicious email pattern", () => {
    const res = validateEmail("test@example.com");
    assert.equal(res.valid, false);
    assert.ok(res.errors.includes("SUSPICIOUS_EMAIL_PATTERN"));
  });
});
