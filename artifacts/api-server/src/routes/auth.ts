import { Router } from "express";
import crypto from "crypto";
import rateLimit from "express-rate-limit";
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
  listUsers,
  authMiddleware,
  Permission,
  requirePermission,
  incrementFailedAttempts,
  resetFailedAttempts,
  isAccountLocked,
  stampLastLogin,
  type UserRole,
} from "../lib/rbac";
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
} from "../lib/firm-invites";
import { auditLog } from "../lib/audit";
import { logger } from "../lib/logger";
import { generateSecret, verifyTOTP, generateOTPAuthURL } from "../lib/totp";
import { encrypt, decrypt } from "../lib/encryption";
import { db } from "@workspace/db";
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
  keyGenerator: (req) => (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim() || req.socket.remoteAddress || "unknown",
});

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
    unauthorized(res, "Invalid credentials");
    return;
  }

  if (await isAccountLocked(user)) {
    const minutesLeft = Math.ceil((new Date(user.locked_until!).getTime() - Date.now()) / 60000);
    await dispatchCriticalAlert("high", "Login attempt on locked account", `Locked account login attempt: ${email}`, undefined);
    errorEnvelope(res, 423, "account_locked", `Account is locked. Try again in ${minutesLeft} minute(s).`);
    return;
  }

  if (!(await verifyPassword(password, user.password_hash))) {
    const result = await incrementFailedAttempts(email);
    if (result.locked) {
      await dispatchCriticalAlert("high", "Account locked after failed attempts", `Account locked: ${email} after ${result.attempts} failed attempts`);
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
    const decryptedSecret = decrypt(user.totp_secret);
    if (!verifyTOTP(decryptedSecret, totp_code)) {
      const result = await incrementFailedAttempts(email);
      if (result.locked) {
        await dispatchCriticalAlert("high", "Account locked after failed MFA", `Account locked: ${email} after ${result.attempts} failed attempts (MFA)`);
        await auditLog("security", String(user.id), "account_locked_mfa", { email, attempts: result.attempts });
      }
      await dispatchCriticalAlert("medium", "Failed MFA attempt", `Failed TOTP verification for: ${email}`);
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
    ip_address: (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim() || req.socket.remoteAddress,
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

  const assignedRole = "viewer";

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
    await auditLog("firm_invite", String(created.id), "created", {
      firm_id: firmId,
      email_prefill: emailPrefill,
      created_by: req.user!.id,
    });
    res.status(201).json({
      id: created.id,
      token: created.plaintext,
      expires_at: created.expiresAt.toISOString(),
      email_prefill: emailPrefill,
    });
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
  const encryptedSecret = encrypt(secret);
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

  const decryptedSecret = decrypt(dbUser.totp_secret);
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
  const decryptedSecret = decrypt(dbUser.totp_secret);
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

router.get("/users", authMiddleware, requirePermission(Permission.USERS_LIST), async (_req, res) => {
  const users = await listUsers();
  res.json(users);
});

export default router;
