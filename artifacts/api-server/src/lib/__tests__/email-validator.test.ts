import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { validateEmail } from "../email-validator";

describe("validateEmail", () => {
  it("validates correct emails", () => {
    const res = validateEmail("user@gmail.com");
    assert.equal(res.valid, true);
    assert.equal(res.errors.length, 0);
  });

  it("handles missing/empty email", () => {
    assert.equal(validateEmail("").valid, false);
    // @ts-expect-error testing invalid type
    assert.equal(validateEmail(null).valid, false);
  });

  it("rejects invalid RFC format", () => {
    const res = validateEmail("notanemail");
    assert.equal(res.valid, false);
    assert.ok(res.errors.includes("INVALID_RFC_FORMAT"));
  });

  it("detects typo domain and offers suggestion", () => {
    const res = validateEmail("user@gnail.com");
    // TYPO_DOMAIN_DETECTED is advisory, so valid remains true
    assert.equal(res.valid, true);
    assert.ok(res.errors.includes("TYPO_DOMAIN_DETECTED"));
    assert.equal(res.suggestion, "user@gmail.com");
  });

  it("detects malformed TLD as hard error", () => {
    const res = validateEmail("user@somecompany.con");
    assert.equal(res.valid, false);
    assert.ok(res.errors.includes("MALFORMED_TLD"));
    assert.equal(res.suggestion, "user@somecompany.com");
  });

  it("detects disposable email as hard error", () => {
    const res = validateEmail("user@tempmail.com");
    assert.equal(res.valid, false);
    assert.ok(res.errors.includes("DISPOSABLE_EMAIL"));
  });

  it("detects suspicious email patterns", () => {
    const res = validateEmail("test@example.com");
    assert.equal(res.valid, false);
    assert.ok(res.errors.includes("SUSPICIOUS_EMAIL_PATTERN"));
  });
});
