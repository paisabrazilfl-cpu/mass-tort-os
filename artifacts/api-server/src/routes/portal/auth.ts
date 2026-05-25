import { Router } from "express";
import rateLimit from "express-rate-limit";
import { z } from "zod";
import { db, portalUsersTable, leadsTable } from "@workspace/db";
import { eq, and, gt, sql } from "drizzle-orm";
import { badRequest, unauthorized, conflict, errorEnvelope } from "../../lib/http-errors";
import {
  portalAuthMiddleware,
  generatePortalToken,
  generatePortalRefreshToken,
  rotatePortalRefreshToken,
  revokePortalTokens,
  hashPassword,
  verifyPassword,
  validatePasswordStrength,
  generateOpaqueToken,
  hashToken,
  writePortalAudit,
  getClientIp,
  getPortalBaseUrl,
  tortTypeToSlug,
} from "../../lib/portal-auth";
import { generateSecret, verifyTOTP, generateOTPAuthURL } from "../../lib/totp";
import { encrypt, decrypt } from "../../lib/encryption";
import { enqueueJob } from "../../lib/queue";
import { logger } from "../../lib/logger";

const router = Router();

// ---------------------------------------------------------------------------
// Rate limiters — applied per IP to limit brute-force surface
// ---------------------------------------------------------------------------

const authRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { status: "error", code: "rate_limited", message: "Too many requests — try again later" },
});

const strictRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { status: "error", code: "rate_limited", message: "Too many attempts — try again later" },
});

// ---------------------------------------------------------------------------
// Zod schemas
// ---------------------------------------------------------------------------

const SignupBody = z.object({
  token: z
    .string()
    .trim()
    .regex(/^[0-9a-f]{64}$/i, "Invalid signup token"),
  password: z.string().min(1).max(1024),
});

const LoginBody = z.object({
  email: z.string().trim().toLowerCase().email().max(254),
  password: z.string().min(1).max(1024),
  totp_code: z.string().regex(/^\d{6}$/).optional(),
});

const RefreshBody = z.object({
  refresh_token: z.string().min(1).max(256),
  portal_user_id: z.coerce.number().int().positive(),
});

const TotpCodeBody = z.object({
  totp_code: z.string().regex(/^\d{6}$/),
});

const VerifyEmailQuery = z.object({
  token: z
    .string()
    .trim()
    .regex(/^[0-9a-f]{64}$/i, "Invalid verification token"),
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function sendPortalVerificationEmail(opts: {
  to: string;
  toName: string;
  tortType: string;
  token: string;
}): Promise<void> {
  const slug = tortTypeToSlug(opts.tortType);
  const base = getPortalBaseUrl();
  const link = `${base}/${slug}/verify-email?token=${opts.token}`;

  const subject = `Verify your ${opts.tortType} portal email address`;
  const html = `
    <p>Hi ${opts.toName},</p>
    <p>Please verify your email address to activate your case portal account:</p>
    <p><a href="${link}" style="background:#1a56db;color:#fff;padding:12px 24px;border-radius:6px;text-decoration:none;display:inline-block;">Verify Email Address</a></p>
    <p>This link expires in 24 hours. If you did not request this, you can safely ignore it.</p>
  `;
  const text = `Verify your email: ${link}\n\nThis link expires in 24 hours.`;

  await enqueueJob("send_workflow_email", { to: opts.to, to_name: opts.toName, subject, html, text });
}

// ---------------------------------------------------------------------------
// POST /portal/auth/signup
// Client sets their password using the one-time token issued when the
// background check passed. On success, an email verification link is sent.
// ---------------------------------------------------------------------------
router.post("/signup", strictRateLimit, async (req, res) => {
  const parsed = SignupBody.safeParse(req.body);
  if (!parsed.success) {
    badRequest(res, "Invalid signup token or password");
    return;
  }
  const { token, password } = parsed.data;

  const tokenHash = hashToken(token);
  const now = new Date();

  const [user] = await db
    .select()
    .from(portalUsersTable)
    .where(
      and(
        eq(portalUsersTable.signup_token_hash, tokenHash),
        gt(portalUsersTable.signup_token_expires_at, now),
      ),
    );

  if (!user) {
    unauthorized(res, "Invalid or expired signup link");
    return;
  }

  if (user.password_hash) {
    conflict(res, "already_signed_up", "This account has already been set up. Please log in.");
    return;
  }

  const strength = validatePasswordStrength(password);
  if (!strength.ok) {
    badRequest(res, strength.reason ?? "Password does not meet requirements");
    return;
  }

  const passwordHash = await hashPassword(password);

  // Generate email verification token
  const { plaintext: verifyPlain, hash: verifyHash } = generateOpaqueToken();
  const verifyExpires = new Date(Date.now() + 24 * 60 * 60 * 1000);

  await db
    .update(portalUsersTable)
    .set({
      password_hash: passwordHash,
      signup_token_hash: null,
      signup_token_expires_at: null,
      email_verification_token_hash: verifyHash,
      email_verification_token_expires_at: verifyExpires,
      updated_at: new Date(),
    })
    .where(eq(portalUsersTable.id, user.id));

  // Look up tort_type from the lead for the email link slug
  const [lead] = await db
    .select({ tort_type: leadsTable.tort_type })
    .from(leadsTable)
    .where(eq(leadsTable.id, user.lead_id));

  await sendPortalVerificationEmail({
    to: user.email,
    toName: user.name,
    tortType: lead?.tort_type ?? "Case",
    token: verifyPlain,
  });

  await writePortalAudit({
    portal_user_id: user.id,
    lead_id: user.lead_id,
    firm_id: user.firm_id,
    action: "portal.signup_complete",
    ip: getClientIp(req),
    user_agent: req.headers["user-agent"],
  });

  res.json({ message: "Account created. Please check your email to verify your address." });
});

// ---------------------------------------------------------------------------
// GET /portal/auth/verify-email?token=<hex>
// ---------------------------------------------------------------------------
router.get("/verify-email", async (req, res) => {
  const parsed = VerifyEmailQuery.safeParse(req.query);
  if (!parsed.success) {
    badRequest(res, "Invalid verification token");
    return;
  }

  const tokenHash = hashToken(parsed.data.token);
  const now = new Date();

  const [user] = await db
    .select()
    .from(portalUsersTable)
    .where(
      and(
        eq(portalUsersTable.email_verification_token_hash, tokenHash),
        gt(portalUsersTable.email_verification_token_expires_at, now),
      ),
    );

  if (!user) {
    badRequest(res, "Invalid or expired verification link");
    return;
  }

  await db
    .update(portalUsersTable)
    .set({
      email_verified_at: new Date(),
      email_verification_token_hash: null,
      email_verification_token_expires_at: null,
      updated_at: new Date(),
    })
    .where(eq(portalUsersTable.id, user.id));

  await writePortalAudit({
    portal_user_id: user.id,
    lead_id: user.lead_id,
    firm_id: user.firm_id,
    action: "portal.email_verified",
    ip: getClientIp(req),
    user_agent: req.headers["user-agent"],
  });

  res.json({ message: "Email verified. You can now log in." });
});

// ---------------------------------------------------------------------------
// POST /portal/auth/login
// ---------------------------------------------------------------------------
router.post("/login", authRateLimit, async (req, res) => {
  const parsed = LoginBody.safeParse(req.body);
  if (!parsed.success) {
    badRequest(res, "Email and password required");
    return;
  }
  const { email, password, totp_code } = parsed.data;
  const ip = getClientIp(req);

  const [user] = await db
    .select()
    .from(portalUsersTable)
    .where(eq(portalUsersTable.email, email));

  // Constant-time branch — don't leak whether the account exists.
  if (!user || !user.password_hash) {
    unauthorized(res, "Invalid credentials");
    return;
  }

  // Account lockout check
  if (user.locked_until && new Date() < user.locked_until) {
    const minutesLeft = Math.ceil((user.locked_until.getTime() - Date.now()) / 60000);
    errorEnvelope(res, 423, "account_locked", `Account locked. Try again in ${minutesLeft} minute(s).`);
    return;
  }

  if (!(await verifyPassword(password, user.password_hash))) {
    const newAttempts = (user.failed_login_attempts ?? 0) + 1;
    const lockedUntil = newAttempts >= 5 ? new Date(Date.now() + 30 * 60 * 1000) : null;

    await db
      .update(portalUsersTable)
      .set({
        failed_login_attempts: newAttempts,
        ...(lockedUntil ? { locked_until: lockedUntil } : {}),
        updated_at: new Date(),
      })
      .where(eq(portalUsersTable.id, user.id));

    await writePortalAudit({
      portal_user_id: user.id,
      lead_id: user.lead_id,
      firm_id: user.firm_id,
      action: "portal.login_failed",
      ip,
      user_agent: req.headers["user-agent"],
      metadata: { reason: "bad_password", attempts: newAttempts },
    });

    unauthorized(res, "Invalid credentials");
    return;
  }

  // MFA gate
  if (user.mfa_enabled && user.totp_secret) {
    if (!totp_code) {
      res.status(200).json({ mfa_required: true, message: "Please provide your TOTP code" });
      return;
    }
    const secret = decrypt(user.totp_secret);
    if (!verifyTOTP(secret, totp_code)) {
      const newAttempts = (user.failed_login_attempts ?? 0) + 1;
      const lockedUntil = newAttempts >= 5 ? new Date(Date.now() + 30 * 60 * 1000) : null;
      await db
        .update(portalUsersTable)
        .set({
          failed_login_attempts: newAttempts,
          ...(lockedUntil ? { locked_until: lockedUntil } : {}),
          updated_at: new Date(),
        })
        .where(eq(portalUsersTable.id, user.id));

      await writePortalAudit({
        portal_user_id: user.id,
        lead_id: user.lead_id,
        firm_id: user.firm_id,
        action: "portal.login_failed",
        ip,
        user_agent: req.headers["user-agent"],
        metadata: { reason: "bad_totp", attempts: newAttempts },
      });

      unauthorized(res, "Invalid TOTP code");
      return;
    }
  }

  // Email verification gate (same ordering as CRM — credential check first)
  if (!user.email_verified_at) {
    await db
      .update(portalUsersTable)
      .set({ failed_login_attempts: 0, updated_at: new Date() })
      .where(eq(portalUsersTable.id, user.id));

    errorEnvelope(
      res,
      403,
      "email_unverified",
      "Please verify your email address before signing in.",
    );
    return;
  }

  // All gates passed — reset lockout, stamp login
  await db
    .update(portalUsersTable)
    .set({
      failed_login_attempts: 0,
      locked_until: null,
      last_login_at: new Date(),
      updated_at: new Date(),
    })
    .where(eq(portalUsersTable.id, user.id));

  const accessToken = generatePortalToken({
    id: user.id,
    lead_id: user.lead_id,
    firm_id: user.firm_id,
    email: user.email,
    name: user.name,
    tv: user.token_version,
  });
  const refreshToken = await generatePortalRefreshToken(user.id);

  await writePortalAudit({
    portal_user_id: user.id,
    lead_id: user.lead_id,
    firm_id: user.firm_id,
    action: "portal.login",
    ip,
    user_agent: req.headers["user-agent"],
  });

  res.json({
    token: accessToken,
    refresh_token: refreshToken,
    expires_in: 900,
    user: {
      id: user.id,
      email: user.email,
      name: user.name,
      mfa_verified: user.mfa_verified,
      // Tells the frontend whether to force /mfa-setup before dashboard access.
      mfa_setup_required: !user.mfa_verified,
    },
  });
});

// ---------------------------------------------------------------------------
// POST /portal/auth/refresh
// ---------------------------------------------------------------------------
router.post("/refresh", authRateLimit, async (req, res) => {
  const parsed = RefreshBody.safeParse(req.body);
  if (!parsed.success) {
    badRequest(res, "refresh_token and portal_user_id required");
    return;
  }

  const result = await rotatePortalRefreshToken(parsed.data.refresh_token, parsed.data.portal_user_id);
  if (!result) {
    unauthorized(res, "Invalid or expired refresh token");
    return;
  }

  res.json({ token: result.accessToken, refresh_token: result.refreshToken, expires_in: 900 });
});

// ---------------------------------------------------------------------------
// POST /portal/auth/logout  (requires portal JWT)
// ---------------------------------------------------------------------------
router.post("/logout", portalAuthMiddleware, async (req, res) => {
  const pu = req.portalUser!;
  await revokePortalTokens(pu.id);

  await writePortalAudit({
    portal_user_id: pu.id,
    lead_id: pu.lead_id,
    firm_id: pu.firm_id,
    action: "portal.logout",
    ip: getClientIp(req),
    user_agent: req.headers["user-agent"],
  });

  res.json({ message: "Logged out" });
});

// ---------------------------------------------------------------------------
// GET /portal/auth/me  (requires portal JWT)
// ---------------------------------------------------------------------------
router.get("/me", portalAuthMiddleware, async (req, res) => {
  const pu = req.portalUser!;
  const [user] = await db
    .select({
      id: portalUsersTable.id,
      email: portalUsersTable.email,
      name: portalUsersTable.name,
      mfa_enabled: portalUsersTable.mfa_enabled,
      mfa_verified: portalUsersTable.mfa_verified,
      lead_id: portalUsersTable.lead_id,
      firm_id: portalUsersTable.firm_id,
    })
    .from(portalUsersTable)
    .where(eq(portalUsersTable.id, pu.id));

  if (!user) {
    unauthorized(res, "Portal account not found");
    return;
  }

  res.json({ user });
});

// ---------------------------------------------------------------------------
// POST /portal/auth/mfa/setup
// Generates a TOTP secret and returns the otpauth:// URL for QR rendering.
// The secret is not stored until /mfa/verify confirms the client can produce
// a valid code — prevents orphaned secrets from half-finished setups.
// ---------------------------------------------------------------------------
router.post("/mfa/setup", portalAuthMiddleware, strictRateLimit, async (req, res) => {
  const pu = req.portalUser!;
  const [user] = await db
    .select({ email: portalUsersTable.email, mfa_verified: portalUsersTable.mfa_verified })
    .from(portalUsersTable)
    .where(eq(portalUsersTable.id, pu.id));

  if (!user) {
    unauthorized(res, "Portal account not found");
    return;
  }

  if (user.mfa_verified) {
    errorEnvelope(res, 409, "mfa_already_enabled", "MFA is already enabled on this account");
    return;
  }

  const secret = generateSecret();
  const encryptedSecret = encrypt(secret);
  const otpauthUrl = generateOTPAuthURL(secret, user.email, "Case Portal");

  // Persist the pending secret — overwrite any previous unverified secret.
  // The secret only becomes "active" when mfa_verified flips to true in /mfa/verify.
  await db
    .update(portalUsersTable)
    .set({ totp_secret: encryptedSecret, mfa_enabled: false, updated_at: new Date() })
    .where(eq(portalUsersTable.id, pu.id));

  await writePortalAudit({
    portal_user_id: pu.id,
    lead_id: pu.lead_id,
    firm_id: pu.firm_id,
    action: "portal.mfa_setup",
    ip: getClientIp(req),
    user_agent: req.headers["user-agent"],
  });

  res.json({
    otpauth_url: otpauthUrl,
    // plaintext secret for manual entry (not all clients support QR scanning)
    secret,
  });
});

// ---------------------------------------------------------------------------
// POST /portal/auth/mfa/verify
// Client submits the 6-digit TOTP code from their authenticator app.
// On success: mfa_enabled and mfa_verified both flip to true.
// ---------------------------------------------------------------------------
router.post("/mfa/verify", portalAuthMiddleware, strictRateLimit, async (req, res) => {
  const parsed = TotpCodeBody.safeParse(req.body);
  if (!parsed.success) {
    badRequest(res, "6-digit TOTP code required");
    return;
  }

  const pu = req.portalUser!;
  const [user] = await db
    .select({
      totp_secret: portalUsersTable.totp_secret,
      mfa_verified: portalUsersTable.mfa_verified,
    })
    .from(portalUsersTable)
    .where(eq(portalUsersTable.id, pu.id));

  if (!user?.totp_secret) {
    errorEnvelope(res, 400, "mfa_not_initiated", "Call /mfa/setup first to generate a secret");
    return;
  }

  if (user.mfa_verified) {
    errorEnvelope(res, 409, "mfa_already_enabled", "MFA is already enabled on this account");
    return;
  }

  const secret = decrypt(user.totp_secret);
  if (!verifyTOTP(secret, parsed.data.totp_code)) {
    await writePortalAudit({
      portal_user_id: pu.id,
      lead_id: pu.lead_id,
      firm_id: pu.firm_id,
      action: "portal.mfa_verify_failed",
      ip: getClientIp(req),
      user_agent: req.headers["user-agent"],
    });
    unauthorized(res, "Invalid TOTP code");
    return;
  }

  await db
    .update(portalUsersTable)
    .set({ mfa_enabled: true, mfa_verified: true, updated_at: new Date() })
    .where(eq(portalUsersTable.id, pu.id));

  await writePortalAudit({
    portal_user_id: pu.id,
    lead_id: pu.lead_id,
    firm_id: pu.firm_id,
    action: "portal.mfa_verify",
    ip: getClientIp(req),
    user_agent: req.headers["user-agent"],
  });

  res.json({ message: "MFA enabled successfully. Your account is now fully secured." });
});

export default router;
