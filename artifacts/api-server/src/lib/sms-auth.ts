/**
 * SMS one-time-code (OTP) authentication.
 *
 * Two surfaces, both backed by the same auth_otp_codes table:
 *   - Phone enrollment — a logged-in user adds a phone number and confirms
 *     ownership with a texted code (purpose = 'phone_verify').
 *   - SMS login — the login page texts a code to the verified phone on the
 *     account (purpose = 'login').
 *
 * Codes are 6 digits, stored only as a SHA-256 hash, single-use, expire in
 * 10 minutes, and are capped at 5 wrong attempts. Delivery goes through the
 * existing Telnyx SMS adapter (lib/sms/telnyx.ts) — no new credentials.
 */
import crypto from "node:crypto";
import { pool } from "@workspace/db";
import { sendSms } from "./sms/telnyx";
import { logger } from "./logger";

export type OtpPurpose = "login" | "phone_verify";
export const OTP_MAX_ATTEMPTS = 5;
const OTP_TTL_MINUTES = 10;

export type OtpResult =
  | { ok: true; id: number; phone: string }
  | { ok: false; reason: "expired" | "too_many" | "mismatch" };

/** Normalize a user-typed phone number to E.164, or null if implausible. */
export function normalizePhone(raw: string): string | null {
  const trimmed = (raw ?? "").trim();
  if (/^\+\d{8,15}$/.test(trimmed)) return trimmed;
  const digits = trimmed.replace(/\D/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return null;
}

/** Mask an E.164 number for display — keeps the country prefix + last 4. */
export function maskPhone(e164: string): string {
  if (!e164 || e164.length < 6) return "•••••";
  return (
    e164.substring(0, 2) +
    "•".repeat(Math.max(0, e164.length - 6)) +
    e164.substring(e164.length - 4)
  );
}

function hashCode(code: string): string {
  return crypto.createHash("sha256").update(code, "utf8").digest("hex");
}

function generateCode(): string {
  return String(crypto.randomInt(0, 1_000_000)).padStart(6, "0");
}

/** Mint + persist a fresh OTP. Returns the plaintext code (to text out). */
export async function createOtp(
  userId: number,
  purpose: OtpPurpose,
  phone: string,
): Promise<string> {
  const code = generateCode();
  await pool.query(
    `INSERT INTO auth_otp_codes (user_id, purpose, code_hash, phone, expires_at)
       VALUES ($1, $2, $3, $4, NOW() + INTERVAL '${OTP_TTL_MINUTES} minutes')`,
    [userId, purpose, hashCode(code), phone],
  );
  return code;
}

/**
 * Verify the most-recent OTP for (user, purpose).
 *
 * On a wrong code the attempt counter is incremented (5 strikes burns it).
 * `consume` defaults to true (single-use); the MFA-aware login route passes
 * `consume: false` to peek, then calls consumeOtpById() once every gate has
 * passed so the code survives a missing-TOTP round-trip.
 */
export async function verifyOtp(
  userId: number,
  purpose: OtpPurpose,
  code: string,
  opts: { consume?: boolean } = {},
): Promise<OtpResult> {
  const r = await pool.query<{ id: number; code_hash: string; phone: string; attempts: number }>(
    `SELECT id, code_hash, phone, attempts FROM auth_otp_codes
       WHERE user_id = $1 AND purpose = $2 AND consumed_at IS NULL AND expires_at > NOW()
       ORDER BY id DESC LIMIT 1`,
    [userId, purpose],
  );
  const row = r.rows[0];
  if (!row) return { ok: false, reason: "expired" };
  if (row.attempts >= OTP_MAX_ATTEMPTS) return { ok: false, reason: "too_many" };

  const a = Buffer.from(hashCode(code), "hex");
  const b = Buffer.from(row.code_hash, "hex");
  const match = a.length === b.length && crypto.timingSafeEqual(a, b);
  if (!match) {
    await pool.query(`UPDATE auth_otp_codes SET attempts = attempts + 1 WHERE id = $1`, [row.id]);
    return { ok: false, reason: "mismatch" };
  }

  if (opts.consume !== false) {
    const consumed = await consumeOtpById(row.id);
    if (!consumed) return { ok: false, reason: "expired" };
  }
  return { ok: true, id: row.id, phone: row.phone };
}

/** Atomically mark an OTP consumed — single-use, race-proof. */
export async function consumeOtpById(id: number): Promise<boolean> {
  const r = await pool.query(
    `UPDATE auth_otp_codes SET consumed_at = NOW() WHERE id = $1 AND consumed_at IS NULL RETURNING id`,
    [id],
  );
  return r.rows.length > 0;
}

/** Text an OTP to a phone. Never throws — returns a structured result. */
export async function sendOtpSms(
  phone: string,
  code: string,
  purpose: OtpPurpose,
): Promise<{ ok: boolean; error?: string }> {
  const label = purpose === "login" ? "sign-in" : "phone verification";
  const body =
    `Your Mass Tort OS ${label} code is ${code}. ` +
    `It expires in ${OTP_TTL_MINUTES} minutes. Do not share it with anyone.`;
  try {
    const res = await sendSms({ to: phone, body });
    if (!res.ok) logger.warn({ error: res.error, purpose }, "OTP SMS send failed");
    return { ok: res.ok, error: res.error };
  } catch (err) {
    logger.error({ err, purpose }, "OTP SMS send threw");
    return { ok: false, error: (err as Error)?.message ?? "SMS send failed" };
  }
}
