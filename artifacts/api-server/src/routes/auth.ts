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
  createUser,
  listUsers,
  authMiddleware,
  Permission,
  requirePermission,
  incrementFailedAttempts,
  resetFailedAttempts,
  isAccountLocked,
} from "../lib/rbac";
import { auditLog } from "../lib/audit";
import { logger } from "../lib/logger";
import { generateSecret, verifyTOTP, generateOTPAuthURL } from "../lib/totp";
import { encrypt, decrypt } from "../lib/encryption";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { dispatchCriticalAlert } from "../lib/security-alerts";

const router = Router();

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
  const [salt, hash] = stored.split(":");
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, 64, (err, derivedKey) => {
      if (err) reject(err);
      else resolve(crypto.timingSafeEqual(Buffer.from(hash, "hex"), derivedKey));
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

  await resetFailedAttempts(email);

  const accessToken = generateToken({ id: user.id, email: user.email, name: user.name, role: user.role as any, token_version: user.token_version });
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

router.post("/register", authRateLimit, async (req, res) => {
  const parsed = RegisterBody.safeParse(req.body);
  if (!parsed.success) { badRequest(res, parsed.error, "Email, password, and name required"); return; }
  const { email, password, name } = parsed.data;

  const passwordError = validatePasswordComplexity(password);
  if (passwordError) { res.status(400).json({ error: passwordError }); return; }

  const assignedRole = "viewer";

  const existing = await getUserByEmail(email);
  if (existing) { res.status(409).json({ error: "Email already registered" }); return; }

  const passwordHash = await hashPassword(password);
  const user = await createUser(email, name, assignedRole, passwordHash);
  const accessToken = generateToken(user);
  const refreshToken = await generateRefreshToken(user.id);

  await auditLog("user", String(user.id), "registered", { email, role: assignedRole });

  res.status(201).json({
    token: accessToken,
    refresh_token: refreshToken,
    expires_in: 900,
    user,
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
