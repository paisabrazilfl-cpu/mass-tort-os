/**
 * Magic-link (passwordless email) sign-in.
 *
 * The flow: the user enters their email on the login page → POST
 * /api/auth/magic-link/request mints a single-use token, stores only its
 * SHA-256 hash in `auth_magic_links`, and emails the plaintext inside a
 * sign-in URL. Clicking the link lands on the SPA's /auth/magic page, which
 * POSTs the token to /api/auth/magic-link/verify to exchange it for a session.
 *
 * Security properties — mirrors lib/email-verification.ts:
 *   - The plaintext token is high-entropy (256 bits) and never persisted, so
 *     a database leak cannot be replayed into a session.
 *   - Single-use: consumed_at flips inside one atomic UPDATE.
 *   - Short-lived: 15-minute TTL (an interactive sign-in, not a 24h email
 *     confirmation — the shorter window narrows the replay surface).
 *   - The plaintext is a live credential: never logged outside an explicit
 *     non-production dev opt-in.
 */
import crypto from "crypto";
import { logger } from "./logger";
import { enqueueJob } from "./queue";
import { hashVerificationToken, resolveAppPublicUrl } from "./email-verification";

const TOKEN_BYTES = 32;
export const MAGIC_LINK_TTL_MS = 15 * 60 * 1000; // 15 minutes
const TTL_MINUTES = MAGIC_LINK_TTL_MS / 60_000;

export interface MagicToken {
  /** URL-safe plaintext token to embed in the sign-in link. */
  plaintext: string;
  /** SHA-256 hex digest — the only form that touches the database. */
  hash: string;
  /** Absolute expiry timestamp; persisted alongside the hash. */
  expiresAt: Date;
}

/** Mint a fresh single-use magic-link token. */
export function generateMagicToken(): MagicToken {
  const plaintext = crypto.randomBytes(TOKEN_BYTES).toString("hex");
  return {
    plaintext,
    hash: hashVerificationToken(plaintext),
    expiresAt: new Date(Date.now() + MAGIC_LINK_TTL_MS),
  };
}

/** Hash a plaintext magic token to its persisted SHA-256 hex form. */
export function hashMagicToken(plaintext: string): string {
  return hashVerificationToken(plaintext);
}

/** Build the user-facing sign-in URL. Consumed by the SPA's /auth/magic page. */
export function buildMagicLinkUrl(plaintext: string): string {
  return `${resolveAppPublicUrl()}/auth/magic?token=${encodeURIComponent(plaintext)}`;
}

function renderMagicLinkEmail(name: string, link: string): { subject: string; html: string; text: string } {
  const safeName = (name || "there").replace(/[<>&]/g, "");
  const subject = "Your MTOS sign-in link";
  const text =
    `Hi ${safeName},\n\n` +
    `Click the link below to sign in to Mass Tort OS:\n\n${link}\n\n` +
    `This link expires in ${TTL_MINUTES} minutes and can be used once. ` +
    `If you did not request it, you can safely ignore this email — your ` +
    `account stays secure.\n\n— Mass Tort OS`;
  const html =
    `<p>Hi ${safeName},</p>` +
    `<p>Click the button below to sign in to Mass Tort OS:</p>` +
    `<p><a href="${link}">Sign in to MTOS</a></p>` +
    `<p>This link expires in ${TTL_MINUTES} minutes and can be used once. ` +
    `If you did not request it, you can safely ignore this email — your ` +
    `account stays secure.</p>` +
    `<p>— Mass Tort OS</p>`;
  return { subject, html, text };
}

/** 8-hex-char fingerprint of the token hash — safe to log for correlation. */
function tokenFingerprint(plaintext: string): string {
  return hashVerificationToken(plaintext).slice(0, 8);
}

/**
 * Dispatch the magic-link email via the job queue (same retry/backoff path
 * as the verification email). Never throws back into the request.
 */
export async function sendMagicLinkEmail(
  to: string,
  toName: string,
  plaintextToken: string,
): Promise<void> {
  const link = buildMagicLinkUrl(plaintextToken);
  const { subject, html, text } = renderMagicLinkEmail(toName, link);
  const fingerprint = tokenFingerprint(plaintextToken);

  logger.info({ to, token_fingerprint: fingerprint, expires_in_minutes: TTL_MINUTES }, "Magic-link sign-in token issued");

  // Dev-only escape hatch — same opt-in gate as the verification email.
  if (process.env["MTOS_LOG_VERIFICATION_LINK"] === "1" && process.env["NODE_ENV"] !== "production") {
    logger.warn({ to, link, token_fingerprint: fingerprint }, "Magic-link emitted in plaintext (dev opt-in) — never enable in production");
  }

  try {
    await enqueueJob("send_workflow_email", { to, to_name: toName, subject, html, text });
  } catch (err) {
    logger.error({ err, to, token_fingerprint: fingerprint }, "Failed to enqueue magic-link email job");
  }
}
