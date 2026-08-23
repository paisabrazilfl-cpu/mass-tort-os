import test from "node:test";
import assert from "node:assert/strict";
import { validateEmail } from "../email-validator";

test("email-validator: validates standard valid emails", () => {
  const result = validateEmail("john.doe@gmail.com");
  assert.equal(result.valid, true);
  assert.deepEqual(result.errors, []);
  assert.equal(result.suggestion, undefined);
});

test("email-validator: handles missing or invalid input", () => {
  assert.deepEqual(validateEmail(""), { valid: false, errors: ["MISSING_EMAIL"] });
  assert.deepEqual(validateEmail(null as unknown as string), { valid: false, errors: ["MISSING_EMAIL"] });
  assert.deepEqual(validateEmail("invalid-email"), { valid: false, errors: ["INVALID_RFC_FORMAT"] });
});

test("email-validator: detects exact domain typos (advisory)", () => {
  const result = validateEmail("user@gnail.com");
  assert.equal(result.valid, true);
  assert.deepEqual(result.errors, ["TYPO_DOMAIN_DETECTED"]);
  assert.equal(result.suggestion, "user@gmail.com");
});

test("email-validator: detects fuzzy domain typos (advisory)", () => {
  const result = validateEmail("user@gmaill.com");
  assert.equal(result.valid, true);
  assert.deepEqual(result.errors, ["LIKELY_TYPO_DOMAIN"]);
  assert.equal(result.suggestion, "user@gmail.com");
});

test("email-validator: detects malformed TLDs", () => {
  const result = validateEmail("user@outlook.con");
  assert.equal(result.valid, false);
  assert.ok(result.errors.includes("MALFORMED_TLD"));
  assert.equal(result.suggestion, "user@outlook.com");
});

test("email-validator: detects disposable email domains", () => {
  const result = validateEmail("user@tempmail.com");
  assert.equal(result.valid, false);
  assert.deepEqual(result.errors, ["DISPOSABLE_EMAIL"]);
});

test("email-validator: detects suspicious email patterns", () => {
  const result = validateEmail("test@example.com");
  assert.equal(result.valid, false);
  assert.deepEqual(result.errors, ["SUSPICIOUS_EMAIL_PATTERN"]);

  const result2 = validateEmail("asdf123@gmail.com");
  assert.equal(result2.valid, false);
  assert.deepEqual(result2.errors, ["SUSPICIOUS_EMAIL_PATTERN"]);
});

test("email-validator: correctly identifies invalid local part and missing TLD", () => {
  const longLocal = "a".repeat(65) + "@gmail.com";
  const result1 = validateEmail(longLocal);
  assert.equal(result1.valid, false);
  assert.ok(result1.errors.includes("INVALID_LOCAL_PART"));

  const noTld = "user@localhost";
  const result2 = validateEmail(noTld);
  assert.equal(result2.valid, false);
  assert.ok(result2.errors.includes("MISSING_TLD"));
});
