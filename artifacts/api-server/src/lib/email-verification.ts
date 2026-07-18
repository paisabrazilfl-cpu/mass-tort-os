// Email verification token helpers for the registration gate (Task #56).
//
// The plaintext token is generated here, returned to the route handler
// so it can be embedded in the verification URL we email out, and then
// hashed before it ever touches the database. We never persist the
// plaintext, so a database leak does not let an attacker complete a
// pending verification.
//
// The hashing function is SHA-256: the token is high-entropy
// (256 bits from crypto.randomBytes), single-use, short-lived (24h),
// and never user-supplied — all the properties that justify a fast
// hash and rule out the need for scrypt/argon2.

import crypto from "crypto";
import { logger } from "./logger";
import { enqueueJob } from "./queue";

const TOKEN_BYTES = 32;
const TOKEN_TTL_MS = 24 * 60 * 60 * 1000;

export interface VerificationToken {
  /** URL-safe plaintext token to embed in the verification link. */
  plaintext: string;
  /** SHA-256 hex digest of the plaintext — what gets persisted. */
  hash: string;
  /** Absolute expiry timestamp; persisted alongside the hash. */
  expiresAt: Date;
}

/**
 * Generate a fresh single-use verification token. The plaintext value
 * is only safe to email — never log it, never persist it, never return
 * it from a non-verification API.
 */
export function generateVerificationToken(): VerificationToken {
  const plaintext = crypto.randomBytes(TOKEN_BYTES).toString("hex");
  const hash = hashVerificationToken(plaintext);
  const expiresAt = new Date(Date.now() + TOKEN_TTL_MS);
  return { plaintext, hash, expiresAt };
}

/**
 * Hash a plaintext verification token to its persisted SHA-256 hex form.
 * Used both at token creation (to store the hash) and at verification
 * (to look up the row by hash).
 */
export function hashVerificationToken(plaintext: string): string {
  return crypto.createHash("sha256").update(plaintext, "utf8").digest("hex");
}

/**
 * Resolve the absolute base URL the verification link should point at.
 *
 * Order of precedence:
 *   1. APP_PUBLIC_URL — explicit operator override (preferred in prod).
 *   2. REPLIT_DOMAINS — first comma-separated entry, prefixed with https://.
 *   3. Fallback to the hard-coded dev URL so local "register" still
 *      yields a clickable link in the server log.
 *
 * The trailing slash is stripped so callers can append "/verify-email?...".
 */
export function resolveAppPublicUrl(): string {
  const explicit = process.env["APP_PUBLIC_URL"];
  if (explicit && explicit.trim().length > 0) {
    return explicit.trim().replace(/\/$/, "");
  }
  const replitDomains = process.env["REPLIT_DOMAINS"];
  if (replitDomains && replitDomains.trim().length > 0) {
    const first = replitDomains.split(",")[0]?.trim();
    if (first) return `https://${first}`.replace(/\/$/, "");
  }
  return "http://localhost:5000";
}

/**
 * Build the user-facing verification URL for a given plaintext token.
 * Lives at /verify-email on the CRM SPA so the page can pass the token
 * to GET /api/auth/verify-email and then store the returned JWT pair.
 */
export function buildVerificationUrl(plaintextToken: string): string {
  return `${resolveAppPublicUrl()}/verify-email?token=${encodeURIComponent(plaintextToken)}`;
}

/**
 * Render the email body for a brand-new pending registration.
 */
function renderVerificationEmail(name: string, link: string): { subject: string; html: string; text: string } {
  const safeName = name.replace(/[<>&]/g, "");
  const subject = "Verify your MTOS email address";
  const text =
    `Hi ${safeName},\n\n` +
    `Please confirm this email address belongs to you so we can finish ` +
    `setting up your MTOS account:\n\n${link}\n\n` +
    `This link will expire in 24 hours. If you did not request an MTOS ` +
    `account, you can ignore this email — no account will be activated.\n\n` +
    `— Mass Tort OS`;
  const html =
    `<p>Hi ${safeName},</p>` +
    `<p>Please confirm this email address belongs to you so we can finish ` +
    `setting up your MTOS account:</p>` +
    `<p><a href="${link}">Verify my email address</a></p>` +
    `<p>This link will expire in 24 hours. If you did not request an MTOS ` +
    `account, you can ignore this email — no account will be activated.</p>` +
    `<p>— Mass Tort OS</p>`;
  return { subject, html, text };
}

/**
 * Short fingerprint of a plaintext token, safe to log. Lets operators
 * cross-reference an email-issued event with a later /verify-email
 * consumption event without ever exposing the credential itself: an
 * 8-hex-char prefix of the SHA-256 has ~32 bits of disambiguation
 * (plenty for log correlation) but is computationally infeasible to
 * invert into the 64-hex-char plaintext.
 */
function tokenFingerprint(plaintextToken: string): string {
  return hashVerificationToken(plaintextToken).slice(0, 8);
}

/**
 * Dispatch the verification email.
 *
 * Logging policy (security-critical — see Task #56 review):
 * The plaintext token IS an authentication credential. Anyone who can
 * read the log can take over a pending account inside the 24h TTL, so
 * we MUST NOT emit the link in shared or production log sinks. We log
 * a token fingerprint (8-hex prefix of the hash) at info level for
 * correlation, and only print the full clickable link when the
 * developer explicitly opts in via MTOS_LOG_VERIFICATION_LINK=1 in a
 * NON-production environment. The opt-in is gated on BOTH the env
 * variable and NODE_ENV !== "production" so a stray prod env var can
 * never re-introduce the leak.
 *
 * The send itself is enqueued onto the job queue (same path the
 * workflow-handler uses) so it inherits retry/backoff and so the
 * register handler stays fast. If no email integration is configured
 * the job will fail at processing time and the failure is visible in
 * the existing job-queue admin UI.
 */
export async function sendVerificationEmail(
  to: string,
  toName: string,
  plaintextToken: string,
): Promise<void> {
  const link = buildVerificationUrl(plaintextToken);
  const { subject, html, text } = renderVerificationEmail(toName, link);

  // Safe, always-on observability: enough metadata to correlate the
  // issue / consume / replay events without leaking the credential.
  const fingerprint = tokenFingerprint(plaintextToken);
  logger.info(
    {
      to,
      token_fingerprint: fingerprint,
      // Hard-coded TTL mirrors TOKEN_TTL_MS — surfaced so operators can
      // see at a glance whether a complaint about an expired link is
      // plausible.
      expires_in_hours: 24,
    },
    "Email verification link issued",
  );

  // Dev-only escape hatch: when no SendGrid integration is wired up,
  // an explicit opt-in lets the developer copy the link out of the
  // local log. Refuses to fire in production even if the env var
  // somehow leaks in.
  if (
    process.env["MTOS_LOG_VERIFICATION_LINK"] === "1" &&
    process.env["NODE_ENV"] !== "production"
  ) {
    logger.warn(
      { to, link, token_fingerprint: fingerprint },
      "Email verification link emitted in plaintext (dev opt-in via MTOS_LOG_VERIFICATION_LINK=1) — never enable this in production",
    );
  }

  try {
    await enqueueJob("send_workflow_email", {
      to,
      to_name: toName,
      subject,
      html,
      text,
    });
  } catch (err) {
    // Never let the email enqueue failure poison the register response.
    // The user already exists in pending state; an admin can re-issue
    // the link via the (forthcoming) resend-verification flow. We
    // intentionally do NOT log the plaintext link here either — same
    // credential-leak concern as the success path.
    let errMessage = String(err && (err as any).message ? (err as any).message : err);
    if (errMessage.includes("Failed query") || errMessage.includes(plaintextToken)) {
      errMessage = "Database query failed (details omitted for security)";
    }
    logger.error(
      {
        err: errMessage,
        to,
        token_fingerprint: fingerprint,
      },
      "Failed to enqueue verification email job",
    );
  }
}
