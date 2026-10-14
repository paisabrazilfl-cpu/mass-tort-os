import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { validateEmail } from "../email-validator";

describe("validateEmail", () => {
  it("rejects non-string or missing email", () => {
    // @ts-expect-error testing invalid input
    assert.deepEqual(validateEmail(null), { valid: false, errors: ["MISSING_EMAIL"] });
    // @ts-expect-error testing invalid input
    assert.deepEqual(validateEmail(undefined), { valid: false, errors: ["MISSING_EMAIL"] });
    assert.deepEqual(validateEmail(""), { valid: false, errors: ["MISSING_EMAIL"] });
  });

  it("rejects RFC invalid email formats", () => {
    const res = validateEmail("invalid-email-no-at");
    assert.strictEqual(res.valid, false);
    assert.ok(res.errors.includes("INVALID_RFC_FORMAT"));
  });

  it("detects typo domains as advisory errors and provides suggestions", () => {
    const res = validateEmail("john.doe@gnail.com");
    assert.strictEqual(res.valid, true);
    assert.ok(res.errors.includes("TYPO_DOMAIN_DETECTED"));
    assert.strictEqual(res.suggestion, "john.doe@gmail.com");
  });

  it("detects fuzzy typo domains as advisory errors", () => {
    const res = validateEmail("john.doe@gmaill.com");
    assert.strictEqual(res.valid, true);
    assert.ok(res.errors.includes("LIKELY_TYPO_DOMAIN"));
    assert.strictEqual(res.suggestion, "john.doe@gmail.com");
  });

  it("detects malformed TLDs", () => {
    const res = validateEmail("user@company.con");
    assert.strictEqual(res.valid, false);
    assert.ok(res.errors.includes("MALFORMED_TLD"));
    assert.strictEqual(res.suggestion, "user@company.com");
  });

  it("detects disposable email domains", () => {
    const res = validateEmail("user@mailinator.com");
    assert.strictEqual(res.valid, false);
    assert.ok(res.errors.includes("DISPOSABLE_EMAIL"));
  });

  it("detects suspicious email patterns", () => {
    const res = validateEmail("test@domain.com");
    assert.strictEqual(res.valid, false);
    assert.ok(res.errors.includes("SUSPICIOUS_EMAIL_PATTERN"));
  });

  it("validates legitimate email addresses", () => {
    const res = validateEmail("john.doe@company.org");
    assert.strictEqual(res.valid, true);
    assert.deepEqual(res.errors, []);
    assert.strictEqual(res.suggestion, undefined);
  });
});
