import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { validateEmail } from "../email-validator";

describe("email-validator", () => {
  it("returns MISSING_EMAIL for empty or invalid inputs", () => {
    assert.deepEqual(validateEmail(""), { valid: false, errors: ["MISSING_EMAIL"] });
    assert.deepEqual(validateEmail(null as unknown as string), { valid: false, errors: ["MISSING_EMAIL"] });
  });

  it("validates standard clean email", () => {
    const res = validateEmail("john.doe@gmail.com");
    assert.strictEqual(res.valid, true);
    assert.deepEqual(res.errors, []);
    assert.strictEqual(res.suggestion, undefined);
  });

  it("detects invalid RFC format", () => {
    const res = validateEmail("invalid-email-format");
    assert.strictEqual(res.valid, false);
    assert.deepEqual(res.errors, ["INVALID_RFC_FORMAT"]);
  });

  it("detects typo domain and provides suggestion (advisory)", () => {
    const res = validateEmail("user@gnail.com");
    assert.strictEqual(res.valid, true); // Advisory code TYPO_DOMAIN_DETECTED does not make valid false
    assert.ok(res.errors.includes("TYPO_DOMAIN_DETECTED"));
    assert.strictEqual(res.suggestion, "user@gmail.com");
  });

  it("detects fuzzy typo domain and provides suggestion (advisory)", () => {
    const res = validateEmail("user@gmaill.com");
    assert.strictEqual(res.valid, true); // LIKELY_TYPO_DOMAIN is advisory
    assert.ok(res.errors.includes("LIKELY_TYPO_DOMAIN"));
    assert.strictEqual(res.suggestion, "user@gmail.com");
  });

  it("detects malformed TLD", () => {
    const res = validateEmail("user@yahoo.con");
    assert.ok(res.errors.includes("MALFORMED_TLD"));
    assert.strictEqual(res.suggestion, "user@yahoo.com");
  });

  it("detects disposable email domain", () => {
    const res = validateEmail("temp@tempmail.com");
    assert.strictEqual(res.valid, false);
    assert.ok(res.errors.includes("DISPOSABLE_EMAIL"));
  });

  it("detects suspicious email patterns", () => {
    const res = validateEmail("test@example.com");
    assert.strictEqual(res.valid, false);
    assert.ok(res.errors.includes("SUSPICIOUS_EMAIL_PATTERN"));
  });
});
