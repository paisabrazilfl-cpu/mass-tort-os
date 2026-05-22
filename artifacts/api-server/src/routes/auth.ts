import { Router } from "express";
import crypto from "crypto";
import rateLimit, { ipKeyGenerator } from "express-rate-limit";
import { errorEnvelope, unauthorized } from "../lib/http-errors";
import {
  generateToken,
  generateRefreshToken,
  rotateRefreshToken,
  revokeAllUserTokens,
  getUserByEmail,
  getUserById,
  getUserByVerificationToken,
  markEmailVerified,
  createUser,
  listUsersByFirm,
  authMiddleware,
  Permission,
  requirePermission,
  requireRole,
  updateUserRoleAndBumpVersion,
  incrementFailedAttempts,
  resetFailedAttempts,
  isAccountLocked,
  stampLastLogin,
  type UserRole,
} from "../lib/rbac";
import {
  STOCK_PIN,
  hashPin,
  verifyPin,
  mintAdminUnlockToken,
  requireAdminUnlock,
} from "../lib/admin-pin";
import {
  generateVerificationToken,
  hashVerificationToken,
  sendVerificationEmail,
} from "../lib/email-verification";
import { getDefaultFirmId } from "../lib/firm-bootstrap";
import {
  createInvite,
  getInvitePreviewByToken,
  listInvitesForFirm,
  lockInviteByToken,
  attachInviteUser,
  sendFirmInviteEmail,
  revokeInvite,
} from "../lib/firm-invites";
import { auditLog } from "../lib/audit";
import { logger } from "../lib/logger";
import { generateSecret, verifyTOTP, generateOTPAuthURL } from "../lib/totp";
import { encrypt, decrypt } from "../lib/encryption";
import { generateMagicToken, hashMagicToken, sendMagicLinkEmail } from "../lib/magic-link";
import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} from "@simplewebauthn/server";
import type { RegistrationResponseJSON, AuthenticationResponseJSON } from "@simplewebauthn/server";
import {
  RP,
  saveChallenge,
  consumeChallenge,
  listCredentials,
  getCredentialById,
  insertCredential,
  updateCounter,
  deleteCredential,
  parseTransports,
} from "../lib/passkey";
import {
  normalizePhone,
  maskPhone,
  createOtp,
  verifyOtp,
  consumeOtpById,
  sendOtpSms,
} from "../lib/sms-auth";
import { db, pool } from "@workspace/db";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { dispatchCriticalAlert } from "../lib/security-alerts";

const router = Router();

// Reserved internal addresses that public registration must reject.
// system@mtos.local identifies the case-ownership-backfill admin user;
// allowing a viewer to register that email would let them inherit
// ownership of every backfilled row.
const RESERVED_EMAILS = new Set<string>(["system@mtos.local"]);

// Inline zod schemas for auth payloads. The api-zod package does not currently
// generate schemas for /auth/* (operations are tagged "auth" but body schemas
// are too loose to be useful). Validating up front prevents undefined/non-string
// inputs from reaching scrypt() / crypto.timingSafeEqual() and crashing
// the request thread.
const LoginBody = z.object({
  email: z.string().trim().toLowerCase().email().max(254),
  password: z.string().min(1).max(1024),
  totp_code: z.string().regex(/^\d{6}$/).optional(),
});
const RefreshBody = z.object({
  refresh_token: z.string().min(1).max(1024),
  user_id: z.coerce.number().int().positive(),
});
const RegisterBody = z.object({
  email: z.string().trim().toLowerCase().email().max(254),
  password: z.string().min(1).max(1024),
  name: z.string().trim().min(1).max(200),
  // Optional firm-invite claim. When supplied AND the token still
  // matches an outstanding row, the new user is bound to the invite's
  // firm instead of the seeded default firm. Hex-only because tokens
  // are crypto.randomBytes(32).toString("hex"); anything else can't
  // possibly match a stored hash so we shape-validate up front.
  invite_token: z
    .string()
    .trim()
    .regex(/^[0-9a-f]{64}$/i, "invite_token must be 64 hex characters")
    .optional(),
});
const InviteInfoQuery = z.object({
  token: z
    .string()
    .trim()
    .regex(/^[0-9a-f]{64}$/i, "token must be 64 hex characters"),
});
const ChangePasswordBody = z.object({
  current_password: z.string().min(1).max(1024),
  new_password: z.string().min(1).max(1024),
});
const TotpCodeBody = z.object({
  totp_code: z.string().regex(/^\d{6}$/),
});
const MfaDisableBody = z.object({
  password: z.string().min(1).max(1024),
  totp_code: z.string().regex(/^\d{6}$/),
});

function badRequest(res: import("express").Response, parseError: z.ZodError, message = "Invalid request body") {
  res.status(400).json({
    status: "error",
    code: "validation_failed",
    message,
    details: parseError.flatten(),
  });
}

const authRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many authentication attempts. Please try again later." },
  // Trust the platform's reverse proxy (set via `app.set("trust proxy", 1)`)
  // so req.ip is the first-hop client IP rather than the immediate Railway
  // edge. Use express-rate-limit's IPv6-aware key helper instead of slicing
  // X-Forwarded-For ourselves — the raw header is operator-controllable and
  // a spoofed XFF previously let an attacker rotate keys and bypass the
  // 20/15m auth limit entirely.
  keyGenerator: (req) => ipKeyGenerator(req.ip ?? req.socket.remoteAddress ?? "unknown"),
});

// Fixed scrypt parameters mirroring `hashPassword`/`verifyPassword` so the
// dummy-verify path costs the same wall-clock as a real one. Used by the
// timing-oracle padding below when the email is unknown.
const TIMING_DUMMY_SALT = "00000000000000000000000000000000";
const TIMING_DUMMY_HASH = Buffer.alloc(64);
async function timingPadVerify(password: string): Promise<void> {
  // Run scrypt to consume ~the same CPU as a real verify, then discard the
  // result. We don't care about the output, only that the response-time
  // oracle ("missing email returns instantly") goes away.
  await new Promise<void>((resolve) => {
    crypto.scrypt(password, TIMING_DUMMY_SALT, 64, (err, derivedKey) => {
      try {
        if (!err) crypto.timingSafeEqual(TIMING_DUMMY_HASH, derivedKey);
      } catch { /* ignore — we only need the CPU work */ }
      resolve();
    });
  });
}

const PASSWORD_RULES = {
  minLength: 12,
  requireUppercase: /[A-Z]/,
  requireLowercase: /[a-z]/,
  requireNumber: /[0-9]/,
  requireSpecial: /[!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?`~]/,
};

function validatePasswordComplexity(password: string): string | null {
  if (password.length < PASSWORD_RULES.minLength) {
    return `Password must be at least ${PASSWORD_RULES.minLength} characters`;
  }
  if (!PASSWORD_RULES.requireUppercase.test(password)) {
    return "Password must contain at least one uppercase letter";
  }
  if (!PASSWORD_RULES.requireLowercase.test(password)) {
    return "Password must contain at least one lowercase letter";
  }
  if (!PASSWORD_RULES.requireNumber.test(password)) {
    return "Password must contain at least one number";
  }
  if (!PASSWORD_RULES.requireSpecial.test(password)) {
    return "Password must contain at least one special character";
  }
  return null;
}

async function hashPassword(password: string): Promise<string> {
  const salt = crypto.randomBytes(16).toString("hex");
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, 64, (err, derivedKey) => {
      if (err) reject(err);
      else resolve(`${salt}:${derivedKey.toString("hex")}`);
    });
  });
}

async function verifyPassword(password: string, stored: string): Promise<boolean> {
  // Fail closed on malformed stored hashes. The expected format is
  // `${salt:hex}:${derivedKey:hex}` (see hashPassword above). A row that
  // doesn't match — corrupted, manually-inserted, or a placeholder for a
  // disabled account — must NEVER fall through to `Buffer.from(undefined,
  // "hex")` or `crypto.timingSafeEqual` with mismatched lengths: both will
  // throw and, because the throw originates inside the scrypt callback
  // (off the request's promise chain), the rejection becomes an
  // unhandled async error and a denial-of-service hazard. Returning
  // `false` here keeps the auth surface honest: bad row ⇒ bad credentials.
  if (typeof stored !== "string" || stored.length === 0) return false;
  const idx = stored.indexOf(":");
  if (idx <= 0 || idx === stored.length - 1) return false;
  const salt = stored.slice(0, idx);
  const hashHex = stored.slice(idx + 1);
  // hex chars only and an even length, otherwise Buffer.from will pad/truncate silently.
  if (hashHex.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(hashHex)) return false;
  const expected = Buffer.from(hashHex, "hex");
  if (expected.length !== 64) return false;
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, 64, (err, derivedKey) => {
      if (err) reject(err);
      else resolve(crypto.timingSafeEqual(expected, derivedKey));
    });
  });
}

router.post("/login", authRateLimit, async (req, res) => {
  const parsed = LoginBody.safeParse(req.body);
  if (!parsed.success) { badRequest(res, parsed.error, "Email and password required"); return; }
  const { email, password, totp_code } = parsed.data;

  const user = await getUserByEmail(email);
  if (!user) {
    // User-enumeration timing oracle defence. If the email is unknown we
    // would otherwise return immediately while a known-email path spends
    // 60–120 ms in scrypt; an attacker can sit on /login and measure that
    // gap to enumerate registered accounts. Burn the same CPU before
    // responding so both branches take the same wall-clock.
    await timingPadVerify(password);
    unauthorized(res, "Invalid credentials");
    return;
  }

  if (await isAccountLocked(user)) {
    const minutesLeft = Math.ceil((new Date(user.locked_until!).getTime() - Date.now()) / 60000);
    // Fire-and-forget — a slow/down alert backend must not block login.
    dispatchCriticalAlert("high", "Login attempt on locked account", `Locked account login attempt: ${email}`, undefined)
      .catch((err) => req.log.warn({ err, email }, "lockout alert dispatch failed"));
    errorEnvelope(res, 423, "account_locked", `Account is locked. Try again in ${minutesLeft} minute(s).`);
    return;
  }

  if (!(await verifyPassword(password, user.password_hash))) {
    const result = await incrementFailedAttempts(email);
    if (result.locked) {
      dispatchCriticalAlert("high", "Account locked after failed attempts", `Account locked: ${email} after ${result.attempts} failed attempts`)
        .catch((err) => req.log.warn({ err, email }, "lockout alert dispatch failed"));
      await auditLog("security", String(user.id), "account_locked", { email, attempts: result.attempts });
    }
    unauthorized(res, "Invalid credentials");
    return;
  }

  if (user.mfa_enabled && user.totp_secret) {
    if (!totp_code) {
      res.status(200).json({ mfa_required: true, message: "Please provide your TOTP code" });
      return;
    }
    // Per-row AAD: bind the TOTP ciphertext to (field="totp_secret",
    // entityId=user.id). Without this, a row-swap from user A → user B
    // silently decrypts via encryption.ts's no-AAD fallback chain and a
    // stolen DB image could let an attacker authenticate as B with A's TOTP.
    const decryptedSecret = decrypt(user.totp_secret, "totp_secret", String(user.id));
    if (!verifyTOTP(decryptedSecret, totp_code)) {
      const result = await incrementFailedAttempts(email);
      if (result.locked) {
        dispatchCriticalAlert("high", "Account locked after failed MFA", `Account locked: ${email} after ${result.attempts} failed attempts (MFA)`)
          .catch((err) => req.log.warn({ err, email }, "mfa lockout alert dispatch failed"));
        await auditLog("security", String(user.id), "account_locked_mfa", { email, attempts: result.attempts });
      }
      dispatchCriticalAlert("medium", "Failed MFA attempt", `Failed TOTP verification for: ${email}`)
        .catch((err) => req.log.warn({ err, email }, "mfa fail alert dispatch failed"));
      unauthorized(res, "Invalid TOTP code");
      return;
    }
  }

  // Email verification gate (Task #56). The user has proven knowledge
  // of the password (and TOTP, if enabled) — the credentials check
  // ALWAYS runs first, so a wrong password against a pending account
  // still 401s instead of 403ing. Only after the password+MFA legs
  // succeed do we surface the verification-required state, which means
  // the new branch is not an enumeration oracle for "does this email
  // exist as a pending registration": a stranger guessing the password
  // would see the same 401 they always have.
  if (user.email_verified_at === null) {
    await resetFailedAttempts(email);
    await auditLog("user", String(user.id), "login_blocked_unverified", { email: user.email });
    errorEnvelope(
      res,
      403,
      "email_unverified",
      "Please verify your email address before signing in. Check your inbox for the verification link.",
    );
    return;
  }

  await resetFailedAttempts(email);
  // Stamp last_login_at AFTER all gates pass (password + MFA + verified)
  // so the column reflects only successful interactive logins. The admin
  // Users page (Task #58) uses this to triage dormant accounts.
  await stampLastLogin(user.id);

  const accessToken = generateToken({
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role as UserRole,
    firm_id: user.firm_id,
    token_version: user.token_version,
  });
  const refreshToken = await generateRefreshToken(user.id);

  await auditLog("user", String(user.id), "login", { email: user.email }, {
    ip_address: req.ip ?? req.socket.remoteAddress,
    user_agent: req.headers["user-agent"],
  });

  res.json({
    token: accessToken,
    refresh_token: refreshToken,
    expires_in: 900,
    user: { id: user.id, email: user.email, name: user.name, role: user.role, mfa_enabled: user.mfa_enabled },
  });
});

router.post("/refresh", authRateLimit, async (req, res) => {
  const parsed = RefreshBody.safeParse(req.body);
  if (!parsed.success) { badRequest(res, parsed.error, "refresh_token and user_id required"); return; }
  const { refresh_token, user_id } = parsed.data;

  const result = await rotateRefreshToken(refresh_token, user_id);
  if (!result) {
    unauthorized(res, "Invalid or expired refresh token");
    return;
  }

  res.json({
    token: result.accessToken,
    refresh_token: result.refreshToken,
    expires_in: 900,
  });
});

router.post("/logout", authMiddleware, async (req, res) => {
  const user = req.user!;
  await revokeAllUserTokens(user.id);

  await auditLog("user", String(user.id), "logout", { email: user.email });

  res.json({ message: "Logged out successfully. All tokens revoked." });
});

// Shared 202 envelope for the register endpoint. Returned for every
// happy-path code path so the response shape is uniform regardless of
// whether the email actually went out (the queue handles retries).
const REGISTER_PENDING_BODY = {
  status: "pending_verification",
  message:
    "Account created. Check your email for a verification link to finish signing up.",
};

router.post("/register", authRateLimit, async (req, res) => {
  const parsed = RegisterBody.safeParse(req.body);
  if (!parsed.success) { badRequest(res, parsed.error, "Email, password, and name required"); return; }
  const { email, password, name, invite_token } = parsed.data;

  // Block public registration of reserved/system addresses. Compared
  // case-insensitively because email addresses are case-insensitive in
  // practice and getUserByEmail normalizes already, but we don't want to
  // depend on that for a security-critical check.
  if (RESERVED_EMAILS.has(email.toLowerCase())) {
    // Return the same 409 the duplicate-email path returns so this
    // endpoint cannot be used as an oracle to enumerate reserved
    // addresses.
    res.status(409).json({ error: "Email already registered" });
    return;
  }

  const passwordError = validatePasswordComplexity(password);
  if (passwordError) { res.status(400).json({ error: passwordError }); return; }

  // MTOS runs a single privileged tier — every account operates with admin
  // capacity (see rbac.ts → elevateRole). New registrations are created as
  // admin so the stored role matches the capacity they actually get.
  const assignedRole = "admin";

  // Treat verified and pending rows identically here. Returning a
  // different status for "already pending verification" would let the
  // endpoint be used to enumerate which addresses have a half-finished
  // registration; the existing 409 already covers verified collisions
  // and we keep it for both. Operators can manually requeue the
  // verification email from the admin dashboard if needed.
  const existing = await getUserByEmail(email);
  if (existing) { res.status(409).json({ error: "Email already registered" }); return; }

  // Resolve the firm BEFORE creating any user state. There are two
  // mutually exclusive paths here, both authoritative:
  //
  //   1. invite_token present → atomically lock the invite via
  //      lockInviteByToken (UPDATE ... WHERE claimed_at IS NULL ...
  //      RETURNING). The row's claimed_at flips inside that single
  //      statement, so concurrent registrations racing the same token
  //      both run this UPDATE but only ONE returns a row; the loser
  //      gets the same generic 4xx an invalid token would. There is no
  //      window between "we believed the token was valid" and "we acted
  //      on it" — the lock IS the acting. If it returns null, we MUST
  //      NOT fall back to the default firm: the user explicitly clicked
  //      an invite link, and silently routing them to a different firm
  //      would be a worse failure than rejecting the request.
  //
  //   2. invite_token absent → fall back to the seeded default firm so
  //      existing single-tenant deployments keep working.
  //
  // Errors here surface as a generic message so the endpoint cannot be
  // used to distinguish wrong / expired / already-claimed tokens.
  let firmId: number;
  let lockedInviteId: number | null = null;
  if (invite_token) {
    // The invitation address IS the account's sign-in email. Reject a
    // mismatched signup BEFORE consuming the token (a non-destructive
    // preview lookup) so a typo doesn't burn the invite.
    const preview = await getInvitePreviewByToken(invite_token);
    if (
      preview &&
      preview.email_prefill &&
      preview.email_prefill.toLowerCase() !== email
    ) {
      res.status(400).json({
        status: "error",
        code: "invite_email_mismatch",
        message:
          "This invitation was sent to a different email address. Sign up with the exact address that received the invite.",
      });
      return;
    }
    const locked = await lockInviteByToken(invite_token);
    if (!locked) {
      res.status(400).json({
        status: "error",
        code: "invalid_invite",
        message: "This invite link is invalid or has expired. Ask the administrator for a new one.",
      });
      return;
    }
    firmId = locked.firm_id;
    lockedInviteId = locked.id;
  } else {
    const defaultFirm = await getDefaultFirmId();
    if (defaultFirm === null) {
      logger.error("register: no default firm row — seedDefaultFirm did not run");
      res.status(503).json({ error: "Account creation temporarily unavailable" });
      return;
    }
    firmId = defaultFirm;
  }

  const passwordHash = await hashPassword(password);

  // Mint a single-use verification token, persist only its hash, and
  // hand the plaintext to the email helper for delivery. The user row
  // is created in the pending state (email_verified_at IS NULL); login
  // will refuse it until the link is consumed.
  const verification = generateVerificationToken();
  const user = await createUser(
    email,
    name,
    assignedRole,
    passwordHash,
    firmId,
    { tokenHash: verification.hash, expiresAt: verification.expiresAt },
  );

  // Step 2 of the two-phase claim: stitch the new user.id onto the row
  // already locked by lockInviteByToken. Best-effort — the invite is
  // ALREADY consumed (claimed_at was set above), so a failure here does
  // not allow reuse and does not warrant rolling back the user. The
  // audit row written below carries firm_id + via_invite for recovery.
  if (lockedInviteId !== null) {
    try {
      await attachInviteUser(lockedInviteId, user.id);
    } catch (err) {
      logger.warn(
        { user_id: user.id, firm_id: firmId, invite_id: lockedInviteId, err },
        "register: attachInviteUser failed; invite remains consumed but claimed_by_user_id was not stitched",
      );
    }
  }

  // Fire-and-await email send. Failures here log and continue —
  // sendVerificationEmail itself handles enqueue errors so this never
  // throws back into the request, but we await it so the audit row is
  // written after the send is at least attempted.
  await sendVerificationEmail(email, name, verification.plaintext);

  await auditLog("user", String(user.id), "registered_pending_verification", {
    email,
    role: assignedRole,
    firm_id: firmId,
    via_invite: Boolean(invite_token),
  });

  // 202 Accepted = "request received, action not complete". The
  // frontend's RegisterPage uses this to switch into the "check your
  // email" state instead of trying to read a JWT pair from the body.
  res.status(202).json(REGISTER_PENDING_BODY);
});

/**
 * Anonymous prefill lookup for an invite link. The /register page reads
 * `?invite=...` from the URL and calls this to (a) confirm the invite
 * is still valid and (b) prefill the email field + render the firm
 * name. Returns a generic 404 envelope for invalid / expired / claimed
 * tokens so the endpoint cannot be used to enumerate invite state.
 *
 * Public on purpose: the user has the invite token but does not yet
 * have a session (the whole flow exists to bootstrap one). The token
 * is the credential.
 */
router.get("/invite-info", authRateLimit, async (req, res) => {
  const parsed = InviteInfoQuery.safeParse(req.query);
  if (!parsed.success) {
    errorEnvelope(
      res,
      404,
      "invalid_invite",
      "This invite link is invalid or has expired.",
    );
    return;
  }
  const preview = await getInvitePreviewByToken(parsed.data.token);
  if (!preview) {
    errorEnvelope(
      res,
      404,
      "invalid_invite",
      "This invite link is invalid or has expired.",
    );
    return;
  }
  res.json({
    firm_name: preview.firm_name,
    email_prefill: preview.email_prefill,
    expires_at: preview.expires_at.toISOString(),
  });
});

// Inline schema for the admin "create invite" body. email_prefill is
// optional convenience; the actual claim is keyed by the token, not the
// address, so a recipient can register with any email.
const CreateInviteBody = z.object({
  email_prefill: z
    .string()
    .trim()
    .toLowerCase()
    .email()
    .max(254)
    .optional()
    .or(z.literal("")),
});

/**
 * List the requester's firm's outstanding + historical invites. Admin
 * only. Each row exposes status (pending / claimed / expired) but never
 * the plaintext token — the link is only surfaced once, on creation.
 */
router.get(
  "/firm-invites",
  authMiddleware,
  requireAdminUnlock,
  requirePermission(Permission.INVITES_MANAGE),
  async (req, res) => {
    const firmId = req.user!.firm_id;
    if (firmId == null) {
      res.status(400).json({ error: "User is not bound to a firm" });
      return;
    }
    const rows = await listInvitesForFirm(firmId);
    const now = Date.now();
    res.json({
      invites: rows.map((r) => {
        // Single-use semantics live on `claimed_at` (see firm-invites.ts);
        // claimed_by_user_id is set in a follow-up update post user-insert
        // and may briefly be null on a "claimed" row. List status follows
        // the authoritative column so the UI never shows a consumed
        // invite as still pending.
        const claimed = r.claimed_at !== null;
        const expired = !claimed && r.expires_at.getTime() <= now;
        return {
          id: r.id,
          email_prefill: r.email_prefill,
          expires_at: r.expires_at.toISOString(),
          claimed_by_user_id: r.claimed_by_user_id,
          claimed_at: r.claimed_at ? r.claimed_at.toISOString() : null,
          created_by_user_id: r.created_by_user_id,
          created_at: r.created_at.toISOString(),
          status: claimed ? "claimed" : expired ? "expired" : "pending",
        };
      }),
    });
  },
);

/**
 * Mint a new firm invite. Admin only. The plaintext token is returned
 * EXACTLY once in this response — it is never persisted in plaintext
 * and never re-readable from /firm-invites GET. The caller renders a
 * shareable URL (`/register?invite=<token>`) for the admin to hand off.
 */
router.post(
  "/firm-invites",
  authMiddleware,
  requireAdminUnlock,
  requirePermission(Permission.INVITES_MANAGE),
  async (req, res) => {
    const parsed = CreateInviteBody.safeParse(req.body ?? {});
    if (!parsed.success) {
      badRequest(res, parsed.error, "Invalid invite payload");
      return;
    }
    const firmId = req.user!.firm_id;
    if (firmId == null) {
      res.status(400).json({ error: "User is not bound to a firm" });
      return;
    }
    const emailPrefillRaw = parsed.data.email_prefill;
    const emailPrefill =
      emailPrefillRaw && emailPrefillRaw.length > 0 ? emailPrefillRaw : null;
    const created = await createInvite({
      firmId,
      createdByUserId: req.user!.id,
      emailPrefill,
    });

    // Email the invite when an address was given — the Teams tab always
    // provides one. The invite is created regardless; a send failure is
    // logged, not fatal (the token is still returned for manual handoff).
    let emailSent = false;
    if (emailPrefill) {
      try {
        const fr = await pool.query<{ name: string }>(
          `SELECT name FROM firms WHERE id = $1 LIMIT 1`,
          [firmId],
        );
        await sendFirmInviteEmail(emailPrefill, fr.rows[0]?.name ?? "your team", created.plaintext);
        emailSent = true;
      } catch (err) {
        logger.error({ err, firmId }, "firm-invite: email send failed (invite still created)");
      }
    }

    await auditLog("firm_invite", String(created.id), "created", {
      firm_id: firmId,
      email_prefill: emailPrefill,
      email_sent: emailSent,
      created_by: req.user!.id,
    });
    res.status(201).json({
      id: created.id,
      token: created.plaintext,
      expires_at: created.expiresAt.toISOString(),
      email_prefill: emailPrefill,
      email_sent: emailSent,
    });
  },
);

/**
 * Revoke an outstanding (unclaimed) firm invite. Admin-only, firm-scoped.
 */
router.delete(
  "/firm-invites/:id",
  authMiddleware,
  requireAdminUnlock,
  requirePermission(Permission.INVITES_MANAGE),
  async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      res.status(400).json({ error: "Invalid invite id" });
      return;
    }
    const firmId = req.user!.firm_id;
    if (firmId == null) {
      res.status(400).json({ error: "User is not bound to a firm" });
      return;
    }
    const removed = await revokeInvite(id, firmId);
    if (!removed) {
      res.status(404).json({ error: "Invite not found, already used, or not in your firm" });
      return;
    }
    await auditLog("firm_invite", String(id), "revoked", {
      firm_id: firmId,
      revoked_by: req.user!.id,
    });
    res.json({ ok: true });
  },
);

// Inline schema for the verify-email query parameter. We require a
// 64-character hex token (32 bytes * 2 hex chars) — anything that fails
// this shape can't possibly match a stored hash, so we fail fast with
// the same generic "invalid or expired" envelope to avoid an oracle.
const VerifyEmailQuery = z.object({
  token: z
    .string()
    .trim()
    .regex(/^[0-9a-f]{64}$/i, "token must be 64 hex characters"),
});

router.get("/verify-email", authRateLimit, async (req, res) => {
  const parsed = VerifyEmailQuery.safeParse(req.query);
  if (!parsed.success) {
    errorEnvelope(
      res,
      400,
      "invalid_token",
      "This verification link is invalid or has expired. Please request a new one.",
    );
    return;
  }

  const { token } = parsed.data;
  const tokenHash = hashVerificationToken(token);

  const user = await getUserByVerificationToken(tokenHash);
  if (!user) {
    // One generic failure for "no match", "expired", and "already used"
    // so the endpoint cannot be used to enumerate token state.
    errorEnvelope(
      res,
      400,
      "invalid_token",
      "This verification link is invalid or has expired. Please request a new one.",
    );
    return;
  }

  // Atomically consume the single-use token. If two concurrent requests
  // race, only one wins; the other gets the same 400 a stale link does.
  const consumed = await markEmailVerified(user.id, tokenHash);
  if (!consumed) {
    errorEnvelope(
      res,
      400,
      "invalid_token",
      "This verification link is invalid or has expired. Please request a new one.",
    );
    return;
  }

  // Re-load the now-verified user via getUserById so we issue the JWT
  // off the post-update token_version (defensive — markEmailVerified
  // does not bump token_version, but a future change might).
  const refreshed = (await getUserById(user.id)) ?? user;

  const accessToken = generateToken({
    id: refreshed.id,
    email: refreshed.email,
    name: refreshed.name,
    role: refreshed.role as UserRole,
    firm_id: refreshed.firm_id,
    token_version: refreshed.token_version,
  });
  const refreshToken = await generateRefreshToken(refreshed.id);

  await auditLog("user", String(refreshed.id), "email_verified", { email: refreshed.email }, {
    ip_address:
      (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim() ||
      req.socket.remoteAddress,
    user_agent: req.headers["user-agent"],
  });

  // Mirror the JWT-pair response shape the original /register handler
  // used, so the verify-email page can drop these into the same auth
  // store and immediately land the user on the dashboard.
  res.status(200).json({
    token: accessToken,
    refresh_token: refreshToken,
    expires_in: 900,
    user: {
      id: refreshed.id,
      email: refreshed.email,
      name: refreshed.name,
      role: refreshed.role,
      firm_id: refreshed.firm_id,
      mfa_enabled: false,
    },
  });
});

// ── Magic-link (passwordless email) sign-in ─────────────────────────────────
// Both routes are PUBLIC — the user has no session yet, the whole point is to
// mint one. They are whitelisted in lib/route-protection.ts → AUTH_ROUTE_EXCEPTIONS.

const MagicLinkRequestBody = z.object({
  email: z.string().trim().toLowerCase().email().max(254),
});
const MagicLinkVerifyBody = z.object({
  token: z.string().trim().regex(/^[0-9a-f]{64}$/i, "token must be 64 hex characters"),
  totp_code: z.string().regex(/^\d{6}$/).optional(),
});

/**
 * Request a magic sign-in link. ALWAYS responds 200 with the same generic
 * body — whether or not the email maps to a verified account — so the
 * endpoint cannot be used to enumerate registered addresses. A link is
 * minted + emailed only for an existing, email-verified account.
 */
router.post("/magic-link/request", authRateLimit, async (req, res) => {
  const parsed = MagicLinkRequestBody.safeParse(req.body);
  if (!parsed.success) { badRequest(res, parsed.error, "A valid email address is required"); return; }
  const { email } = parsed.data;

  const user = await getUserByEmail(email);
  if (user && user.email_verified_at !== null) {
    try {
      const tok = generateMagicToken();
      await pool.query(
        `INSERT INTO auth_magic_links (user_id, token_hash, expires_at, created_ip)
         VALUES ($1, $2, $3, $4)`,
        [user.id, tok.hash, tok.expiresAt, req.ip ?? req.socket.remoteAddress ?? null],
      );
      await sendMagicLinkEmail(user.email, user.name, tok.plaintext);
      await auditLog("user", String(user.id), "magic_link_requested", { email: user.email }, {
        ip_address: req.ip ?? req.socket.remoteAddress,
        user_agent: req.headers["user-agent"],
      });
    } catch (err) {
      // Never leak a failure back to the caller — that would itself be an
      // enumeration signal. Log for ops and still return the generic body.
      logger.error({ err, email }, "magic-link request: failed to mint/send token");
    }
  }

  res.json({
    status: "ok",
    message: "If an account exists for that email, a sign-in link is on its way.",
  });
});

/**
 * Exchange a magic-link token for a session. The token proves control of
 * the account's email (one factor); an MFA-enabled account must still
 * present its TOTP code, so this can return { mfa_required: true } without
 * consuming the token — the link stays valid for the second round-trip
 * until its 15-minute TTL lapses.
 */
router.post("/magic-link/verify", authRateLimit, async (req, res) => {
  const parsed = MagicLinkVerifyBody.safeParse(req.body);
  if (!parsed.success) { badRequest(res, parsed.error, "A valid sign-in token is required"); return; }
  const { token, totp_code } = parsed.data;
  const tokenHash = hashMagicToken(token);

  // Look up a still-valid, unconsumed token. Not consumed here — an
  // MFA-enabled account needs a second round-trip with the TOTP code.
  const linkRes = await pool.query<{ id: number; user_id: number }>(
    `SELECT id, user_id FROM auth_magic_links
       WHERE token_hash = $1 AND consumed_at IS NULL AND expires_at > NOW()
       LIMIT 1`,
    [tokenHash],
  );
  const link = linkRes.rows[0];
  if (!link) {
    errorEnvelope(res, 400, "invalid_token", "This sign-in link is invalid or has expired. Request a new one.");
    return;
  }

  // Pull the full user row directly — getUserById omits mfa/lock columns.
  const userRes = await pool.query<{
    id: number; email: string; name: string; role: string;
    firm_id: number; token_version: number;
    mfa_enabled: boolean; totp_secret: string | null;
    locked_until: Date | null; failed_login_attempts: number;
  }>(
    `SELECT id, email, name, role, firm_id, token_version,
            mfa_enabled, totp_secret, locked_until, failed_login_attempts
       FROM mtos_users WHERE id = $1 LIMIT 1`,
    [link.user_id],
  );
  const user = userRes.rows[0];
  if (!user) {
    errorEnvelope(res, 400, "invalid_token", "This sign-in link is invalid or has expired. Request a new one.");
    return;
  }

  if (await isAccountLocked(user)) {
    const minutesLeft = Math.ceil((new Date(user.locked_until!).getTime() - Date.now()) / 60000);
    errorEnvelope(res, 423, "account_locked", `Account is locked. Try again in ${minutesLeft} minute(s).`);
    return;
  }

  // MFA still applies — a magic link is a single factor.
  if (user.mfa_enabled && user.totp_secret) {
    if (!totp_code) {
      res.status(200).json({ mfa_required: true, message: "Enter your authenticator code to finish signing in." });
      return;
    }
    const decryptedSecret = decrypt(user.totp_secret, "totp_secret", String(user.id));
    if (!verifyTOTP(decryptedSecret, totp_code)) {
      unauthorized(res, "Invalid authenticator code.");
      return;
    }
  }

  // Atomically consume — single-use, race-proof against a double-click.
  const consumed = await pool.query(
    `UPDATE auth_magic_links SET consumed_at = NOW()
       WHERE id = $1 AND consumed_at IS NULL RETURNING id`,
    [link.id],
  );
  if (consumed.rows.length === 0) {
    errorEnvelope(res, 400, "invalid_token", "This sign-in link has already been used. Request a new one.");
    return;
  }

  await resetFailedAttempts(user.email);
  await stampLastLogin(user.id);

  const accessToken = generateToken({
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role as UserRole,
    firm_id: user.firm_id,
    token_version: user.token_version,
  });
  const refreshToken = await generateRefreshToken(user.id);

  await auditLog("user", String(user.id), "login_magic_link", { email: user.email }, {
    ip_address: req.ip ?? req.socket.remoteAddress,
    user_agent: req.headers["user-agent"],
  });

  res.json({
    token: accessToken,
    refresh_token: refreshToken,
    expires_in: 900,
    user: { id: user.id, email: user.email, name: user.name, role: user.role, mfa_enabled: user.mfa_enabled },
  });
});

// ── Passkey (WebAuthn) sign-in ──────────────────────────────────────────────
// login/options + login/verify are PUBLIC (whitelisted in route-protection.ts
// → AUTH_ROUTE_EXCEPTIONS). register/* + credentials require a session — any
// signed-in user manages their own passkeys, no role gate.

router.post("/passkey/register/options", authMiddleware, async (req, res) => {
  const user = req.user!;
  const existing = await listCredentials(user.id);
  const options = await generateRegistrationOptions({
    rpName: RP.rpName,
    rpID: RP.rpID,
    userName: user.email,
    userID: new TextEncoder().encode(String(user.id)),
    userDisplayName: user.name,
    attestationType: "none",
    excludeCredentials: existing.map((c) => ({
      id: c.credential_id,
      transports: parseTransports(c.transports),
    })),
    authenticatorSelection: { residentKey: "preferred", userVerification: "preferred" },
  });
  const challengeId = await saveChallenge("register", user.id, options.challenge);
  res.json({ challengeId, options });
});

router.post("/passkey/register/verify", authMiddleware, async (req, res) => {
  const user = req.user!;
  const { challengeId, response, deviceName } = (req.body ?? {}) as {
    challengeId?: unknown;
    response?: unknown;
    deviceName?: unknown;
  };
  if (typeof challengeId !== "string" || !response || typeof response !== "object") {
    res.status(400).json({ error: "challengeId and response are required" });
    return;
  }
  const ch = await consumeChallenge(challengeId, "register");
  if (!ch || ch.user_id !== user.id) {
    res.status(400).json({ error: "Passkey setup expired — please start again." });
    return;
  }
  let verification;
  try {
    verification = await verifyRegistrationResponse({
      response: response as RegistrationResponseJSON,
      expectedChallenge: ch.challenge,
      expectedOrigin: RP.origin,
      expectedRPID: RP.rpID,
      requireUserVerification: false,
    });
  } catch (err) {
    res.status(400).json({ error: `Passkey registration failed: ${(err as Error).message}` });
    return;
  }
  if (!verification.verified || !verification.registrationInfo) {
    res.status(400).json({ error: "Passkey could not be verified." });
    return;
  }
  const cred = verification.registrationInfo.credential;
  const name =
    typeof deviceName === "string" && deviceName.trim()
      ? deviceName.trim().slice(0, 80)
      : "Passkey";
  await insertCredential({
    userId: user.id,
    credentialId: cred.id,
    publicKey: Buffer.from(cred.publicKey).toString("base64url"),
    counter: cred.counter,
    transports: cred.transports ?? [],
    deviceName: name,
  });
  await auditLog("user", String(user.id), "passkey_registered", { email: user.email });
  res.json({ ok: true });
});

router.get("/passkey/credentials", authMiddleware, async (req, res) => {
  const creds = await listCredentials(req.user!.id);
  res.json({
    passkeys: creds.map((c) => ({
      id: c.id,
      device_name: c.device_name,
      created_at: c.created_at,
      last_used_at: c.last_used_at,
    })),
  });
});

router.delete("/passkey/credentials/:id", authMiddleware, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: "Invalid passkey id" });
    return;
  }
  const removed = await deleteCredential(req.user!.id, id);
  if (!removed) {
    res.status(404).json({ error: "Passkey not found" });
    return;
  }
  await auditLog("user", String(req.user!.id), "passkey_removed", { passkey_id: id });
  res.json({ ok: true });
});

router.post("/passkey/login/options", authRateLimit, async (_req, res) => {
  // Discoverable-credential ceremony — no allowCredentials, so the browser
  // offers any passkey bound to this site and the user types no username.
  const options = await generateAuthenticationOptions({
    rpID: RP.rpID,
    userVerification: "preferred",
  });
  const challengeId = await saveChallenge("authenticate", null, options.challenge);
  res.json({ challengeId, options });
});

router.post("/passkey/login/verify", authRateLimit, async (req, res) => {
  const { challengeId, response } = (req.body ?? {}) as {
    challengeId?: unknown;
    response?: unknown;
  };
  if (
    typeof challengeId !== "string" ||
    !response ||
    typeof response !== "object" ||
    typeof (response as { id?: unknown }).id !== "string"
  ) {
    res.status(400).json({ error: "challengeId and response are required" });
    return;
  }
  const ch = await consumeChallenge(challengeId, "authenticate");
  if (!ch) {
    errorEnvelope(res, 400, "invalid_token", "This sign-in attempt expired. Please try again.");
    return;
  }
  const stored = await getCredentialById((response as { id: string }).id);
  if (!stored) {
    unauthorized(res, "This passkey is not recognized.");
    return;
  }
  let verification;
  try {
    verification = await verifyAuthenticationResponse({
      response: response as AuthenticationResponseJSON,
      expectedChallenge: ch.challenge,
      expectedOrigin: RP.origin,
      expectedRPID: RP.rpID,
      credential: {
        id: stored.credential_id,
        publicKey: Buffer.from(stored.public_key, "base64url"),
        counter: Number(stored.counter),
        transports: parseTransports(stored.transports),
      },
      requireUserVerification: false,
    });
  } catch (err) {
    unauthorized(res, `Passkey verification failed: ${(err as Error).message}`);
    return;
  }
  if (!verification.verified) {
    unauthorized(res, "Passkey verification failed.");
    return;
  }
  await updateCounter(stored.credential_id, verification.authenticationInfo.newCounter);

  const userRes = await pool.query<{
    id: number;
    email: string;
    name: string;
    role: string;
    firm_id: number;
    token_version: number;
    mfa_enabled: boolean;
    locked_until: Date | null;
    failed_login_attempts: number;
  }>(
    `SELECT id, email, name, role, firm_id, token_version, mfa_enabled,
            locked_until, failed_login_attempts
       FROM mtos_users WHERE id = $1 LIMIT 1`,
    [stored.user_id],
  );
  const user = userRes.rows[0];
  if (!user) {
    unauthorized(res, "This passkey is not recognized.");
    return;
  }
  if (await isAccountLocked(user)) {
    const minutesLeft = Math.ceil((new Date(user.locked_until!).getTime() - Date.now()) / 60000);
    errorEnvelope(res, 423, "account_locked", `Account is locked. Try again in ${minutesLeft} minute(s).`);
    return;
  }

  // A passkey ceremony is possession + on-device user verification — a
  // phishing-resistant strong factor — so it stands on its own; no separate
  // TOTP step even for an MFA-enabled account.
  await resetFailedAttempts(user.email);
  await stampLastLogin(user.id);
  const accessToken = generateToken({
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role as UserRole,
    firm_id: user.firm_id,
    token_version: user.token_version,
  });
  const refreshToken = await generateRefreshToken(user.id);
  await auditLog("user", String(user.id), "login_passkey", { email: user.email }, {
    ip_address: req.ip ?? req.socket.remoteAddress,
    user_agent: req.headers["user-agent"],
  });
  res.json({
    token: accessToken,
    refresh_token: refreshToken,
    expires_in: 900,
    user: { id: user.id, email: user.email, name: user.name, role: user.role, mfa_enabled: user.mfa_enabled },
  });
});

// ── SMS one-time-code sign-in ───────────────────────────────────────────────
// sms/request + sms/verify are PUBLIC (whitelisted in route-protection.ts).
// phone/* are authed self-service — a user enrolls/manages their own number.

const SmsRequestBody = z.object({
  email: z.string().trim().toLowerCase().email().max(254),
});
const SmsVerifyBody = z.object({
  email: z.string().trim().toLowerCase().email().max(254),
  code: z.string().regex(/^\d{6}$/),
  totp_code: z.string().regex(/^\d{6}$/).optional(),
});
const PhoneRequestBody = z.object({
  phone: z.string().trim().min(8).max(20),
});
const PhoneVerifyBody = z.object({
  code: z.string().regex(/^\d{6}$/),
});

/**
 * Request a sign-in code by SMS. ALWAYS responds 200 with the same generic
 * body — a code is texted only when the email maps to a verified account
 * that has a verified phone — so the endpoint leaks neither registered
 * emails nor which accounts carry a phone.
 */
router.post("/sms/request", authRateLimit, async (req, res) => {
  const parsed = SmsRequestBody.safeParse(req.body);
  if (!parsed.success) { badRequest(res, parsed.error, "A valid email address is required"); return; }
  const { email } = parsed.data;
  try {
    const r = await pool.query<{
      id: number; phone: string | null;
      phone_verified_at: Date | null; email_verified_at: Date | null;
    }>(
      `SELECT id, phone, phone_verified_at, email_verified_at
         FROM mtos_users WHERE email = $1 LIMIT 1`,
      [email],
    );
    const u = r.rows[0];
    if (u && u.email_verified_at !== null && u.phone && u.phone_verified_at !== null) {
      const code = await createOtp(u.id, "login", u.phone);
      const sent = await sendOtpSms(u.phone, code, "login");
      if (sent.ok) {
        await auditLog("user", String(u.id), "sms_code_requested", { email }, {
          ip_address: req.ip ?? req.socket.remoteAddress,
          user_agent: req.headers["user-agent"],
        });
      } else {
        logger.warn({ email, error: sent.error }, "sms/request: code minted but SMS send failed");
      }
    }
  } catch (err) {
    logger.error({ err, email }, "sms/request failed");
  }
  res.json({
    status: "ok",
    message: "If an account with a verified phone exists, a sign-in code is on its way.",
  });
});

/**
 * Exchange an SMS code for a session. The code proves control of the phone
 * (one factor); an MFA-enabled account must still present its TOTP code, so
 * this can return { mfa_required: true } without consuming the code.
 */
router.post("/sms/verify", authRateLimit, async (req, res) => {
  const parsed = SmsVerifyBody.safeParse(req.body);
  if (!parsed.success) { badRequest(res, parsed.error, "Email and a 6-digit code are required"); return; }
  const { email, code, totp_code } = parsed.data;

  const userRes = await pool.query<{
    id: number; email: string; name: string; role: string;
    firm_id: number; token_version: number; mfa_enabled: boolean;
    totp_secret: string | null; locked_until: Date | null; failed_login_attempts: number;
  }>(
    `SELECT id, email, name, role, firm_id, token_version, mfa_enabled,
            totp_secret, locked_until, failed_login_attempts
       FROM mtos_users WHERE email = $1 LIMIT 1`,
    [email],
  );
  const user = userRes.rows[0];
  // One generic failure for unknown email / wrong / expired code.
  if (!user) {
    errorEnvelope(res, 400, "invalid_code", "That code is invalid or has expired.");
    return;
  }
  if (await isAccountLocked(user)) {
    const minutesLeft = Math.ceil((new Date(user.locked_until!).getTime() - Date.now()) / 60000);
    errorEnvelope(res, 423, "account_locked", `Account is locked. Try again in ${minutesLeft} minute(s).`);
    return;
  }

  // Peek the code — do not consume yet; an MFA account needs a second pass.
  const otp = await verifyOtp(user.id, "login", code, { consume: false });
  if (!otp.ok) {
    errorEnvelope(res, 400, "invalid_code", "That code is invalid or has expired.");
    return;
  }

  if (user.mfa_enabled && user.totp_secret) {
    if (!totp_code) {
      res.status(200).json({ mfa_required: true, message: "Enter your authenticator code to finish signing in." });
      return;
    }
    const decryptedSecret = decrypt(user.totp_secret, "totp_secret", String(user.id));
    if (!verifyTOTP(decryptedSecret, totp_code)) {
      unauthorized(res, "Invalid authenticator code.");
      return;
    }
  }

  // Every gate passed — consume the code now (single-use, race-proof).
  const consumed = await consumeOtpById(otp.id);
  if (!consumed) {
    errorEnvelope(res, 400, "invalid_code", "That code was already used. Request a new one.");
    return;
  }

  await resetFailedAttempts(user.email);
  await stampLastLogin(user.id);
  const accessToken = generateToken({
    id: user.id, email: user.email, name: user.name,
    role: user.role as UserRole, firm_id: user.firm_id, token_version: user.token_version,
  });
  const refreshToken = await generateRefreshToken(user.id);
  await auditLog("user", String(user.id), "login_sms_code", { email: user.email }, {
    ip_address: req.ip ?? req.socket.remoteAddress,
    user_agent: req.headers["user-agent"],
  });
  res.json({
    token: accessToken,
    refresh_token: refreshToken,
    expires_in: 900,
    user: { id: user.id, email: user.email, name: user.name, role: user.role, mfa_enabled: user.mfa_enabled },
  });
});

router.post("/phone/request", authMiddleware, async (req, res) => {
  const parsed = PhoneRequestBody.safeParse(req.body);
  if (!parsed.success) { badRequest(res, parsed.error, "A phone number is required"); return; }
  const phone = normalizePhone(parsed.data.phone);
  if (!phone) {
    res.status(400).json({ error: "Enter a valid phone number (e.g. +1 555 123 4567)." });
    return;
  }
  const user = req.user!;
  const code = await createOtp(user.id, "phone_verify", phone);
  const sent = await sendOtpSms(phone, code, "phone_verify");
  if (!sent.ok) {
    res.status(502).json({
      error: sent.error || "Couldn't send the verification text. Check the number and try again.",
    });
    return;
  }
  await auditLog("user", String(user.id), "phone_verify_requested", { phone: maskPhone(phone) });
  res.json({ ok: true, phone_masked: maskPhone(phone) });
});

router.post("/phone/verify", authMiddleware, async (req, res) => {
  const parsed = PhoneVerifyBody.safeParse(req.body);
  if (!parsed.success) { badRequest(res, parsed.error, "A 6-digit code is required"); return; }
  const user = req.user!;
  const otp = await verifyOtp(user.id, "phone_verify", parsed.data.code);
  if (!otp.ok) {
    res.status(400).json({
      error:
        otp.reason === "too_many"
          ? "Too many wrong attempts. Request a new code."
          : "That code is invalid or has expired.",
    });
    return;
  }
  await pool.query(
    `UPDATE mtos_users SET phone = $2, phone_verified_at = NOW(), updated_at = NOW() WHERE id = $1`,
    [user.id, otp.phone],
  );
  await auditLog("user", String(user.id), "phone_verified", { phone: maskPhone(otp.phone) });
  res.json({ ok: true, phone_masked: maskPhone(otp.phone) });
});

router.get("/phone", authMiddleware, async (req, res) => {
  const r = await pool.query<{ phone: string | null; phone_verified_at: Date | null }>(
    `SELECT phone, phone_verified_at FROM mtos_users WHERE id = $1 LIMIT 1`,
    [req.user!.id],
  );
  const u = r.rows[0];
  res.json({
    phone: u?.phone ? maskPhone(u.phone) : null,
    verified: Boolean(u?.phone_verified_at),
  });
});

router.delete("/phone", authMiddleware, async (req, res) => {
  await pool.query(
    `UPDATE mtos_users SET phone = NULL, phone_verified_at = NULL, updated_at = NOW() WHERE id = $1`,
    [req.user!.id],
  );
  await auditLog("user", String(req.user!.id), "phone_removed", {});
  res.json({ ok: true });
});

// ── Admin PIN gate (super_admin sudo mode) ──────────────────────────────────
// admin-pin/status, /unlock, /change are role-gated to super_admin. promote
// and demote additionally require requireAdminUnlock — you must be unlocked
// to change another user's super_admin status. See lib/admin-pin.ts.

const AdminPinUnlockBody = z.object({ pin: z.string().regex(/^\d{4,8}$/) });
const AdminPinChangeBody = z.object({
  current_pin: z.string().regex(/^\d{4,8}$/),
  new_pin: z.string().regex(/^\d{4,8}$/),
});
const SuperAdminTargetParams = z.object({ id: z.coerce.number().int().positive() });

/**
 * Caller-state query: am I a super_admin and is my PIN still the stock
 * 1234? The frontend uses this to decide whether to show the unlock
 * screen or the "set your PIN" forced-change flow.
 */
router.get(
  "/admin-pin/status",
  authMiddleware,
  requireRole("super_admin"),
  async (req, res) => {
    const r = await pool.query<{ admin_pin_hash: string | null; admin_pin_changed_at: Date | null }>(
      `SELECT admin_pin_hash, admin_pin_changed_at FROM mtos_users WHERE id = $1`,
      [req.user!.id],
    );
    const row = r.rows[0];
    res.json({
      is_super_admin: true,
      pin_set: Boolean(row?.admin_pin_hash),
      on_stock_pin: !row?.admin_pin_hash,
      changed_at: row?.admin_pin_changed_at?.toISOString() ?? null,
    });
  },
);

/**
 * Verify the PIN. When the account is still on the stock value, do NOT
 * mint an unlock token — return must_change so the caller is forced to
 * pick a real PIN via /admin-pin/change before any admin function unlocks.
 */
router.post(
  "/admin-pin/unlock",
  authRateLimit,
  authMiddleware,
  requireRole("super_admin"),
  async (req, res) => {
    const parsed = AdminPinUnlockBody.safeParse(req.body);
    if (!parsed.success) { badRequest(res, parsed.error, "PIN must be 4–8 digits"); return; }
    const user = req.user!;
    const r = await pool.query<{ admin_pin_hash: string | null }>(
      `SELECT admin_pin_hash FROM mtos_users WHERE id = $1`,
      [user.id],
    );
    const stored = r.rows[0]?.admin_pin_hash ?? null;
    const ok = await verifyPin(parsed.data.pin, stored);
    if (!ok) {
      unauthorized(res, "Invalid PIN.");
      return;
    }
    if (!stored) {
      // Stock-pin path. The unlock is acknowledged but no token is minted;
      // the caller must change the PIN first.
      await auditLog("user", String(user.id), "admin_pin_unlock_stock", { firm_id: user.firm_id });
      res.status(200).json({
        ok: true,
        must_change: true,
        message: "You're using the stock PIN. Set a new PIN to unlock admin functions.",
      });
      return;
    }
    const { token, expiresInSec } = mintAdminUnlockToken(user.id);
    await auditLog("user", String(user.id), "admin_pin_unlocked", { firm_id: user.firm_id }, {
      ip_address: req.ip ?? req.socket.remoteAddress,
      user_agent: req.headers["user-agent"],
    });
    res.json({ ok: true, unlock_token: token, expires_in: expiresInSec });
  },
);

/**
 * Change the PIN. Used for both the forced first-change (from stock 1234)
 * and routine rotations. On success the caller is effectively unlocked —
 * a fresh unlock token is issued in the same response.
 */
router.post(
  "/admin-pin/change",
  authRateLimit,
  authMiddleware,
  requireRole("super_admin"),
  async (req, res) => {
    const parsed = AdminPinChangeBody.safeParse(req.body);
    if (!parsed.success) {
      badRequest(res, parsed.error, "current_pin and new_pin (4–8 digits) are required");
      return;
    }
    const { current_pin, new_pin } = parsed.data;
    if (new_pin === STOCK_PIN) {
      res.status(400).json({
        status: "error",
        code: "new_pin_is_stock",
        message: `Choose a PIN other than ${STOCK_PIN}.`,
      });
      return;
    }
    if (new_pin === current_pin) {
      res.status(400).json({ status: "error", code: "new_pin_unchanged", message: "Pick a different new PIN." });
      return;
    }
    const user = req.user!;
    const r = await pool.query<{ admin_pin_hash: string | null }>(
      `SELECT admin_pin_hash FROM mtos_users WHERE id = $1`,
      [user.id],
    );
    const stored = r.rows[0]?.admin_pin_hash ?? null;
    const ok = await verifyPin(current_pin, stored);
    if (!ok) {
      unauthorized(res, "Current PIN is incorrect.");
      return;
    }
    const newHash = await hashPin(new_pin);
    await pool.query(
      `UPDATE mtos_users SET admin_pin_hash = $2, admin_pin_changed_at = NOW(), updated_at = NOW()
         WHERE id = $1`,
      [user.id, newHash],
    );
    const { token, expiresInSec } = mintAdminUnlockToken(user.id);
    await auditLog("user", String(user.id), "admin_pin_changed", { firm_id: user.firm_id }, {
      ip_address: req.ip ?? req.socket.remoteAddress,
      user_agent: req.headers["user-agent"],
    });
    res.json({ ok: true, unlock_token: token, expires_in: expiresInSec });
  },
);

/**
 * Promote a team member to super_admin. The new super_admin's PIN is
 * reset to stock (1234) — they must change it on first unlock.
 */
router.post(
  "/super-admin/promote/:id",
  authMiddleware,
  requireRole("super_admin"),
  requireAdminUnlock,
  async (req, res) => {
    const parsed = SuperAdminTargetParams.safeParse(req.params);
    if (!parsed.success) { badRequest(res, parsed.error, "Invalid user id"); return; }
    const targetId = parsed.data.id;
    const actor = req.user!;
    if (targetId === actor.id) {
      res.status(403).json({
        status: "error",
        code: "cannot_promote_self",
        message: "You're already a super admin.",
      });
      return;
    }
    const updated = await updateUserRoleAndBumpVersion(targetId, actor.firm_id, "super_admin");
    if (!updated) { res.status(404).json({ error: "User not found" }); return; }
    // Reset their PIN to stock so they're forced to set their own on first unlock.
    await pool.query(
      `UPDATE mtos_users SET admin_pin_hash = NULL, admin_pin_changed_at = NULL, updated_at = NOW()
         WHERE id = $1 AND firm_id = $2`,
      [targetId, actor.firm_id],
    );
    await auditLog(
      "user",
      String(targetId),
      "promoted_super_admin",
      {
        actor_user_id: actor.id,
        firm_id: actor.firm_id,
        before: { role: updated.previous_role },
        after: { role: "super_admin" },
      },
      { ip_address: req.ip ?? req.socket.remoteAddress, user_agent: req.headers["user-agent"] },
    );
    res.json({
      ok: true,
      user: { id: updated.id, email: updated.email, name: updated.name, role: "super_admin" },
    });
  },
);

/**
 * Demote a super_admin back to admin. Refuses to demote the LAST super_admin
 * in the firm — otherwise the firm could lock itself out of every gated action.
 */
router.post(
  "/super-admin/demote/:id",
  authMiddleware,
  requireRole("super_admin"),
  requireAdminUnlock,
  async (req, res) => {
    const parsed = SuperAdminTargetParams.safeParse(req.params);
    if (!parsed.success) { badRequest(res, parsed.error, "Invalid user id"); return; }
    const targetId = parsed.data.id;
    const actor = req.user!;
    if (targetId === actor.id) {
      res.status(403).json({
        status: "error",
        code: "cannot_demote_self",
        message: "You cannot demote yourself. Ask another super admin to do it.",
      });
      return;
    }
    // Never strip a firm of its only super admin.
    const cnt = await pool.query<{ c: string }>(
      `SELECT COUNT(*)::text AS c FROM mtos_users WHERE firm_id = $1 AND role = 'super_admin'`,
      [actor.firm_id],
    );
    if (Number(cnt.rows[0]?.c ?? 0) <= 1) {
      res.status(409).json({
        status: "error",
        code: "last_super_admin",
        message: "Promote another super admin first — you can't leave the firm without one.",
      });
      return;
    }
    const updated = await updateUserRoleAndBumpVersion(targetId, actor.firm_id, "admin");
    if (!updated) { res.status(404).json({ error: "User not found" }); return; }
    if (updated.previous_role !== "super_admin") {
      // Wasn't a super_admin — undo to avoid a silent role flip.
      await updateUserRoleAndBumpVersion(targetId, actor.firm_id, updated.previous_role as UserRole);
      res.status(400).json({
        status: "error",
        code: "not_super_admin",
        message: "That user isn't a super admin.",
      });
      return;
    }
    await pool.query(
      `UPDATE mtos_users SET admin_pin_hash = NULL, admin_pin_changed_at = NULL, updated_at = NOW()
         WHERE id = $1 AND firm_id = $2`,
      [targetId, actor.firm_id],
    );
    await auditLog(
      "user",
      String(targetId),
      "demoted_super_admin",
      {
        actor_user_id: actor.id,
        firm_id: actor.firm_id,
        before: { role: "super_admin" },
        after: { role: "admin" },
      },
      { ip_address: req.ip ?? req.socket.remoteAddress, user_agent: req.headers["user-agent"] },
    );
    res.json({
      ok: true,
      user: { id: updated.id, email: updated.email, name: updated.name, role: "admin" },
    });
  },
);

router.post("/change-password", authMiddleware, async (req, res) => {
  const parsed = ChangePasswordBody.safeParse(req.body);
  if (!parsed.success) { badRequest(res, parsed.error, "current_password and new_password required"); return; }
  const { current_password, new_password } = parsed.data;

  const passwordError = validatePasswordComplexity(new_password);
  if (passwordError) { res.status(400).json({ error: passwordError }); return; }

  const user = await getUserByEmail(req.user!.email);
  if (!user || !(await verifyPassword(current_password, user.password_hash))) {
    unauthorized(res, "Current password is incorrect");
    return;
  }

  const newHash = await hashPassword(new_password);
  await db.execute(sql`
    UPDATE mtos_users SET password_hash = ${newHash}, token_version = token_version + 1, updated_at = NOW()
    WHERE id = ${req.user!.id}
  `);

  await revokeAllUserTokens(req.user!.id);
  await auditLog("user", String(req.user!.id), "password_changed", { email: req.user!.email });

  res.json({ message: "Password changed. All existing sessions have been revoked. Please log in again." });
});

router.post("/mfa/setup", authMiddleware, async (req, res) => {
  const user = req.user!;
  const dbUser = await getUserByEmail(user.email);
  if (!dbUser) { res.status(404).json({ error: "User not found" }); return; }
  if (dbUser.mfa_enabled) { res.status(409).json({ error: "MFA is already enabled" }); return; }

  const secret = generateSecret();
  // Per-row AAD: bind ciphertext to (field="totp_secret", entityId=user.id).
  // Without this the encryption.ts no-AAD fallback would accept a row-swap
  // and let an attacker who can write rows authenticate as user B with user
  // A's TOTP secret. MFA login + disable paths decrypt with the same AAD.
  const encryptedSecret = encrypt(secret, "totp_secret", String(user.id));
  const otpauthUrl = generateOTPAuthURL(secret, user.email);

  await db.execute(sql`
    UPDATE mtos_users SET totp_secret = ${encryptedSecret}, updated_at = NOW()
    WHERE id = ${user.id}
  `);

  res.json({
    secret,
    otpauth_url: otpauthUrl,
    message: "Scan the QR code or enter the secret in your authenticator app, then call /mfa/verify to activate.",
  });
});

router.post("/mfa/verify", authMiddleware, async (req, res) => {
  const parsed = TotpCodeBody.safeParse(req.body);
  if (!parsed.success) { badRequest(res, parsed.error, "totp_code required (6 digits)"); return; }
  const { totp_code } = parsed.data;

  const user = req.user!;
  const dbUser = await getUserByEmail(user.email);
  if (!dbUser || !dbUser.totp_secret) { res.status(400).json({ error: "MFA setup not initiated" }); return; }

  const decryptedSecret = decrypt(dbUser.totp_secret, "totp_secret", String(user.id));
  if (!verifyTOTP(decryptedSecret, totp_code)) {
    unauthorized(res, "Invalid TOTP code. Please try again.");
    return;
  }

  await db.execute(sql`
    UPDATE mtos_users SET mfa_enabled = true, updated_at = NOW()
    WHERE id = ${user.id}
  `);

  await auditLog("user", String(user.id), "mfa_enabled", { email: user.email });

  res.json({ message: "MFA enabled successfully.", mfa_enabled: true });
});

router.post("/mfa/disable", authMiddleware, async (req, res) => {
  const parsed = MfaDisableBody.safeParse(req.body);
  if (!parsed.success) { badRequest(res, parsed.error, "Password and TOTP code required to disable MFA"); return; }
  const { totp_code, password } = parsed.data;

  const user = req.user!;
  const dbUser = await getUserByEmail(user.email);
  if (!dbUser) { res.status(404).json({ error: "User not found" }); return; }
  if (!dbUser.mfa_enabled) { res.status(400).json({ error: "MFA is not enabled" }); return; }

  if (!(await verifyPassword(password, dbUser.password_hash))) {
    unauthorized(res, "Invalid password");
    return;
  }

  if (!dbUser.totp_secret) { res.status(400).json({ error: "MFA setup incomplete" }); return; }
  const decryptedSecret = decrypt(dbUser.totp_secret, "totp_secret", String(user.id));
  if (!verifyTOTP(decryptedSecret, totp_code)) {
    unauthorized(res, "Invalid TOTP code");
    return;
  }

  await db.execute(sql`
    UPDATE mtos_users SET mfa_enabled = false, totp_secret = NULL, updated_at = NOW()
    WHERE id = ${user.id}
  `);

  await auditLog("user", String(user.id), "mfa_disabled", { email: user.email });

  res.json({ message: "MFA disabled successfully." });
});

router.get("/me", authMiddleware, async (req, res) => {
  const dbUser = await getUserByEmail(req.user!.email);
  res.json({
    id: req.user!.id,
    email: req.user!.email,
    name: req.user!.name,
    role: req.user!.role,
    mfa_enabled: dbUser?.mfa_enabled ?? false,
  });
});

// Legacy endpoint — kept for backward compatibility but firm-scoped to
// match the modern /api/users surface (Task #58). Previously this called
// the global listUsers() which returned every user across every firm
// under USERS_LIST, a cross-tenant enumeration leak in a multi-firm
// world. Now the response is restricted to the caller's own firm via
// the same listUsersByFirm helper used by /api/users.
router.get("/users", authMiddleware, requireAdminUnlock, requirePermission(Permission.USERS_LIST), async (req, res) => {
  const firmId = req.user!.firm_id;
  const users = await listUsersByFirm(firmId);
  res.json(users);
});

export default router;
