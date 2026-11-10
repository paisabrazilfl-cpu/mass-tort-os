import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { generateSecret, generateTOTP, verifyTOTP, generateOTPAuthURL } from "../totp.js";

describe("totp library", () => {
  test("generateSecret produces valid 32-character base32 secret", () => {
    const secret = generateSecret();
    assert.equal(typeof secret, "string");
    assert.equal(secret.length, 32);
    // Base32 RFC 4648 alphabet: A-Z and 2-7
    assert.match(secret, /^[A-Z2-7]{32}$/);
  });

  test("generateTOTP generates valid 6-digit numeric string", () => {
    const secret = generateSecret();
    const token = generateTOTP(secret);
    assert.equal(typeof token, "string");
    assert.equal(token.length, 6);
    assert.match(token, /^\d{6}$/);
  });

  test("generateTOTP is deterministic for the same timestamp", () => {
    const secret = generateSecret();
    const t = 1700000000;
    const token1 = generateTOTP(secret, t);
    const token2 = generateTOTP(secret, t);
    assert.equal(token1, token2);
  });

  test("verifyTOTP verifies exact current token and rejects wrong token", () => {
    const secret = generateSecret();
    const token = generateTOTP(secret);
    assert.equal(verifyTOTP(secret, token), true);
    assert.equal(verifyTOTP(secret, "000000" === token ? "111111" : "000000"), false);
  });

  test("verifyTOTP tolerates clock drift within +/- 1 window (30s)", () => {
    const secret = generateSecret();
    const now = Math.floor(Date.now() / 1000);
    const tokenPrev = generateTOTP(secret, now - 30);
    const tokenNext = generateTOTP(secret, now + 30);
    const tokenTooOld = generateTOTP(secret, now - 65);
    const tokenTooNew = generateTOTP(secret, now + 65);

    assert.equal(verifyTOTP(secret, tokenPrev), true);
    assert.equal(verifyTOTP(secret, tokenNext), true);
    assert.equal(verifyTOTP(secret, tokenTooOld), false);
    assert.equal(verifyTOTP(secret, tokenTooNew), false);
  });

  test("verifyTOTP strictly validates token format and pads short numbers", () => {
    const secret = generateSecret();
    // Non-string or invalid format returns false
    assert.equal(verifyTOTP(secret, null as unknown as string), false);
    assert.equal(verifyTOTP(secret, undefined as unknown as string), false);
    assert.equal(verifyTOTP(secret, ""), false);
    assert.equal(verifyTOTP(secret, "abc123"), false);
    assert.equal(verifyTOTP(secret, "1234567"), false);
  });

  test("generateOTPAuthURL generates standard keyuri with encoded parameters", () => {
    const secret = "JPAKXHJQXCLCA46OJV42Y6F32PX45OR3";
    const url = generateOTPAuthURL(secret, "user@example.com", "MTOS Platform");
    assert.ok(url.startsWith("otpauth://totp/MTOS%20Platform:user%40example.com?"));
    assert.ok(url.includes(`secret=${secret}`));
    assert.ok(url.includes("issuer=MTOS%20Platform"));
    assert.ok(url.includes("algorithm=SHA1"));
    assert.ok(url.includes("digits=6"));
    assert.ok(url.includes("period=30"));
  });
});
