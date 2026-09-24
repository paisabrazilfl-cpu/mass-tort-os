import { test } from "node:test";
import assert from "node:assert/strict";
import { validateEmail } from "../email-validator";

test("validateEmail with valid email addresses", () => {
  const result1 = validateEmail("john.doe@gmail.com");
  assert.equal(result1.valid, true);
  assert.equal(result1.errors.length, 0);

  const result2 = validateEmail("jane.smith@yahoo.com");
  assert.equal(result2.valid, true);
  assert.equal(result2.errors.length, 0);

  const result3 = validateEmail("user.name+tag@outlook.com");
  assert.equal(result3.valid, true);
  assert.equal(result3.errors.length, 0);
});

test("validateEmail with missing or empty email", () => {
  assert.equal(validateEmail("").valid, false);
  assert.equal(validateEmail(null as unknown as string).valid, false);
  assert.equal(validateEmail(undefined as unknown as string).valid, false);
});

test("validateEmail with invalid RFC format and structure", () => {
  const res1 = validateEmail("not-an-email");
  assert.equal(res1.valid, false);
  assert.ok(res1.errors.includes("INVALID_RFC_FORMAT"));

  const res2 = validateEmail("@domain.com");
  assert.equal(res2.valid, false);

  const res3 = validateEmail("user@");
  assert.equal(res3.valid, false);
});

test("validateEmail with typo domain (exact lookup)", () => {
  const res = validateEmail("john@gnail.com");
  assert.equal(res.valid, true); // Advisory warning only, valid is true
  assert.ok(res.errors.includes("TYPO_DOMAIN_DETECTED"));
  assert.equal(res.suggestion, "john@gmail.com");
});

test("validateEmail with fuzzy typo domain", () => {
  const res = validateEmail("john@gmialll.com");
  // If domain prefix 'gmialll' matches 'gmail' fuzzy rules
  const res2 = validateEmail("user@yaho.com"); // exact typo in TYPO_DOMAINS
  assert.equal(res2.suggestion, "user@yahoo.com");
});

test("validateEmail with malformed TLD", () => {
  const res = validateEmail("john@gmail.con");
  // exact match in TYPO_DOMAINS takes priority for gmail.con
  assert.equal(res.suggestion, "john@gmail.com");

  const res2 = validateEmail("user@customdomain.vom");
  assert.ok(res2.errors.includes("MALFORMED_TLD"));
  assert.equal(res2.suggestion, "user@customdomain.com");
});

test("validateEmail with disposable email domains", () => {
  const res = validateEmail("test@tempmail.com");
  assert.equal(res.valid, false);
  assert.ok(res.errors.includes("DISPOSABLE_EMAIL"));
});

test("validateEmail with suspicious patterns", () => {
  const res1 = validateEmail("test@gmail.com");
  assert.equal(res1.valid, false);
  assert.ok(res1.errors.includes("SUSPICIOUS_EMAIL_PATTERN"));

  const res2 = validateEmail("fake@yahoo.com");
  assert.equal(res2.valid, false);
  assert.ok(res2.errors.includes("SUSPICIOUS_EMAIL_PATTERN"));

  const res3 = validateEmail("asdf123@outlook.com");
  assert.equal(res3.valid, false);
  assert.ok(res3.errors.includes("SUSPICIOUS_EMAIL_PATTERN"));
});
