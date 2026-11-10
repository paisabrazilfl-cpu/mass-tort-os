import crypto from "crypto";

const TOTP_PERIOD = 30;
const TOTP_DIGITS = 6;
const TOTP_WINDOW = 1;
const POW_10 = 1000000;

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

// Pre-computed lookup table for base32 character-to-index mapping (case-insensitive)
const BASE32_LOOKUP = new Int8Array(256).fill(-1);
for (let i = 0; i < BASE32_ALPHABET.length; i++) {
  BASE32_LOOKUP[BASE32_ALPHABET.charCodeAt(i)] = i;
  BASE32_LOOKUP[BASE32_ALPHABET.toLowerCase().charCodeAt(i)] = i;
}

// Module-scoped reusable 8-byte buffer for HOTP counter serialization
const COUNTER_BUF = Buffer.alloc(8);

/**
 * Optimized Base32 encoding using direct bitwise shifting rather than
 * intermediate string binary representations and string slicing.
 */
function base32Encode(buffer: Buffer): string {
  let result = "";
  let val = 0;
  let bits = 0;
  for (let i = 0; i < buffer.length; i++) {
    val = (val << 8) | buffer[i];
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      result += BASE32_ALPHABET[(val >>> bits) & 31];
    }
  }
  if (bits > 0) {
    result += BASE32_ALPHABET[(val << (5 - bits)) & 31];
  }
  return result;
}

/**
 * Optimized Base32 decoding using a fast integer lookup table and bit shifting
 * directly into a pre-allocated Buffer, avoiding binary string conversions and regexes.
 */
function base32Decode(encoded: string): Buffer {
  let len = encoded.length;
  // Ignore trailing padding '='
  while (len > 0 && encoded.charCodeAt(len - 1) === 61) len--;

  let buffer = 0;
  let bitsLeft = 0;
  let outLen = 0;
  // Maximum possible decoded bytes: floor(len * 5 / 8)
  const maxBytes = (len * 5) >> 3;
  const out = Buffer.allocUnsafe(maxBytes);

  for (let i = 0; i < len; i++) {
    const code = encoded.charCodeAt(i);
    const val = code < 256 ? BASE32_LOOKUP[code] : -1;
    if (val === -1) continue;
    buffer = (buffer << 5) | val;
    bitsLeft += 5;
    if (bitsLeft >= 8) {
      bitsLeft -= 8;
      out[outLen++] = (buffer >> bitsLeft) & 0xff;
    }
  }

  return outLen === maxBytes ? out : out.subarray(0, outLen);
}

/**
 * Generate HOTP code for a given counter. Reuses COUNTER_BUF to avoid heap allocation.
 */
function generateHOTP(secret: Buffer, counter: bigint): string {
  COUNTER_BUF.writeBigUInt64BE(counter, 0);
  const hmac = crypto.createHmac("sha1", secret).update(COUNTER_BUF).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const code = (
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff)
  ) % POW_10;
  return code.toString().padStart(TOTP_DIGITS, "0");
}

export function generateSecret(): string {
  const buffer = crypto.randomBytes(20);
  return base32Encode(buffer);
}

export function generateTOTP(secret: string, time?: number): string {
  const secretBuffer = base32Decode(secret);
  const counter = BigInt(Math.floor((time ?? Date.now() / 1000) / TOTP_PERIOD));
  return generateHOTP(secretBuffer, counter);
}

export function verifyTOTP(secret: string, token: string): boolean {
  if (typeof token !== "string") return false;
  // Strict: reject anything that isn't 1-6 ASCII digits. No whitespace, no
  // unicode digits, no leading "+", etc. Padded to 6 for the constant-time
  // compare against the canonical 6-digit HOTP output.
  if (!/^\d{1,6}$/.test(token)) return false;
  const padded = token.padStart(TOTP_DIGITS, "0");
  const tokenBuf = Buffer.from(padded, "utf8");
  if (tokenBuf.length !== TOTP_DIGITS) return false;

  const now = Math.floor(Date.now() / 1000);
  const secretBuffer = base32Decode(secret);
  const currentCounter = BigInt(Math.floor(now / TOTP_PERIOD));
  let matched = false;

  for (let i = -TOTP_WINDOW; i <= TOTP_WINDOW; i++) {
    const counter = currentCounter + BigInt(i);
    const expected = generateHOTP(secretBuffer, counter);
    const expectedBuf = Buffer.from(expected, "utf8");
    if (expectedBuf.length === tokenBuf.length && crypto.timingSafeEqual(expectedBuf, tokenBuf)) {
      matched = true;
    }
  }
  return matched;
}

export function generateOTPAuthURL(secret: string, email: string, issuer = "MTOS"): string {
  return `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(email)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=${TOTP_DIGITS}&period=${TOTP_PERIOD}`;
}
