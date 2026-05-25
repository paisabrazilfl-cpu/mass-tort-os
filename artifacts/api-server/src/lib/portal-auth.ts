import { type Request, type Response, type NextFunction } from "express";
import jwt from "jsonwebtoken";
import crypto from "crypto";
import { db, portalUsersTable, portalAuditLogTable } from "@workspace/db";
import { eq, sql } from "drizzle-orm";
import { logger } from "./logger";
import { unauthorized as sendUnauthorized } from "./http-errors";

const IS_PROD_LIKE = process.env.NODE_ENV === "production" || process.env.NODE_ENV === "staging";

// Separate secret from SESSION_SECRET — portal JWTs are never valid for CRM
// routes and vice versa. Falls back to a dev-only string so the portal can be
// exercised locally without extra env setup.
const PORTAL_JWT_SECRET = (() => {
  const secret = process.env.CLIENT_PORTAL_JWT_SECRET;
  if (IS_PROD_LIKE && !secret) {
    throw new Error("FATAL: CLIENT_PORTAL_JWT_SECRET is required in production/staging");
  }
  return secret ?? "mtos-portal-dev-secret-change-in-prod";
})();

const PORTAL_ACCESS_TOKEN_EXPIRY = "15m";
const PORTAL_REFRESH_TOKEN_EXPIRY_MS = 7 * 24 * 60 * 60 * 1000;

// =============================================================================
// Types
// =============================================================================

export interface PortalAuthUser {
  id: number;
  lead_id: number;
  firm_id: number;
  email: string;
  name: string;
  tv: number;
  // Set only during super-admin impersonation sessions.
  impersonation?: boolean;
  admin_id?: number;
}

declare global {
  namespace Express {
    interface Request {
      portalUser?: PortalAuthUser;
    }
  }
}

// =============================================================================
// JWT helpers
// =============================================================================

export function generatePortalToken(user: PortalAuthUser): string {
  return jwt.sign(
    {
      id: user.id,
      lead_id: user.lead_id,
      firm_id: user.firm_id,
      email: user.email,
      name: user.name,
      tv: user.tv,
      ...(user.impersonation ? { impersonation: true, admin_id: user.admin_id } : {}),
    },
    PORTAL_JWT_SECRET,
    { expiresIn: PORTAL_ACCESS_TOKEN_EXPIRY },
  );
}

function decodePortalToken(token: string): (PortalAuthUser & { tv: number }) | null {
  try {
    return jwt.verify(token, PORTAL_JWT_SECRET, { algorithms: ["HS256"] }) as PortalAuthUser & {
      tv: number;
    };
  } catch {
    return null;
  }
}

// =============================================================================
// portalAuthMiddleware
// =============================================================================

export async function portalAuthMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith("Bearer ")) {
    sendUnauthorized(res, "Portal authentication required");
    return;
  }

  const decoded = decodePortalToken(authHeader.slice(7));
  if (!decoded) {
    sendUnauthorized(res, "Invalid or expired portal token");
    return;
  }

  // token_version revocation — fail closed on DB outage.
  try {
    const result = await db.execute(
      sql`SELECT token_version FROM portal_users WHERE id = ${decoded.id} LIMIT 1`,
    );
    const rows = Array.isArray(result) ? result : ((result as unknown as { rows: unknown[] }).rows ?? []);
    const row = rows[0] as { token_version: number } | undefined;
    if (!row) {
      sendUnauthorized(res, "Portal account not found");
      return;
    }
    if (typeof decoded.tv === "number" && decoded.tv < (row.token_version ?? 0)) {
      sendUnauthorized(res, "Portal session revoked — please log in again");
      return;
    }
  } catch {
    logger.error("Portal token version check failed — denying (fail-closed)");
    res.status(503).json({
      status: "error",
      code: "AUTH_UNAVAILABLE",
      message: "Authentication temporarily unavailable",
    });
    return;
  }

  req.portalUser = {
    id: decoded.id,
    lead_id: decoded.lead_id,
    firm_id: decoded.firm_id,
    email: decoded.email,
    name: decoded.name,
    tv: decoded.tv,
    ...(decoded.impersonation ? { impersonation: true, admin_id: decoded.admin_id } : {}),
  };
  next();
}

// requirePortalMfa gates routes that need MFA to be fully set up.
// Mount after portalAuthMiddleware; reads the DB to get the live mfa_verified flag
// rather than embedding it in the JWT (avoids stale state during setup flow).
export async function requirePortalMfa(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const pu = req.portalUser;
  if (!pu) {
    sendUnauthorized(res, "Portal authentication required");
    return;
  }
  const [user] = await db
    .select({ mfa_verified: portalUsersTable.mfa_verified })
    .from(portalUsersTable)
    .where(eq(portalUsersTable.id, pu.id));

  if (!user?.mfa_verified) {
    res.status(403).json({
      status: "error",
      code: "MFA_REQUIRED",
      message: "Multi-factor authentication setup required before accessing this resource",
    });
    return;
  }
  next();
}

// =============================================================================
// Password helpers — identical pattern to routes/auth.ts
// =============================================================================

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.randomBytes(16).toString("hex");
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, 64, (err, derivedKey) => {
      if (err) reject(err);
      else resolve(`${salt}:${derivedKey.toString("hex")}`);
    });
  });
}

export async function verifyPassword(
  password: string,
  stored: string | null | undefined,
): Promise<boolean> {
  if (!stored || typeof stored !== "string" || stored.length === 0) return false;
  const idx = stored.indexOf(":");
  if (idx <= 0 || idx === stored.length - 1) return false;
  const salt = stored.slice(0, idx);
  const hashHex = stored.slice(idx + 1);
  if (hashHex.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(hashHex)) return false;
  const expected = Buffer.from(hashHex, "hex");
  if (expected.length !== 64) return false;
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, 64, (err, derivedKey) => {
      if (err) {
        reject(err);
        return;
      }
      try {
        resolve(crypto.timingSafeEqual(expected, derivedKey));
      } catch {
        resolve(false);
      }
    });
  });
}

export function validatePasswordStrength(password: string): { ok: boolean; reason?: string } {
  if (password.length < 12) return { ok: false, reason: "Password must be at least 12 characters" };
  if (!/[A-Z]/.test(password)) return { ok: false, reason: "Must contain an uppercase letter" };
  if (!/[a-z]/.test(password)) return { ok: false, reason: "Must contain a lowercase letter" };
  if (!/[0-9]/.test(password)) return { ok: false, reason: "Must contain a number" };
  return { ok: true };
}

// =============================================================================
// Opaque token utilities (signup tokens, email verify tokens)
// =============================================================================

export function generateOpaqueToken(): { plaintext: string; hash: string } {
  const plaintext = crypto.randomBytes(32).toString("hex");
  const hash = crypto.createHash("sha256").update(plaintext).digest("hex");
  return { plaintext, hash };
}

export function hashToken(plaintext: string): string {
  return crypto.createHash("sha256").update(plaintext).digest("hex");
}

// =============================================================================
// Refresh token management (single active session stored on portal_users row)
// =============================================================================

export async function generatePortalRefreshToken(portalUserId: number): Promise<string> {
  const { plaintext, hash } = generateOpaqueToken();
  const expiresAt = new Date(Date.now() + PORTAL_REFRESH_TOKEN_EXPIRY_MS);
  await db
    .update(portalUsersTable)
    .set({ refresh_token_hash: hash, refresh_token_expires_at: expiresAt })
    .where(eq(portalUsersTable.id, portalUserId));
  return plaintext;
}

export async function rotatePortalRefreshToken(
  oldToken: string,
  portalUserId: number,
): Promise<{ accessToken: string; refreshToken: string } | null> {
  const oldHash = hashToken(oldToken);

  const [user] = await db
    .select()
    .from(portalUsersTable)
    .where(eq(portalUsersTable.id, portalUserId));

  if (!user) return null;
  if (!user.refresh_token_hash || user.refresh_token_hash !== oldHash) return null;
  if (!user.refresh_token_expires_at || new Date() > user.refresh_token_expires_at) return null;

  const { plaintext: newPlaintext, hash: newHash } = generateOpaqueToken();
  const expiresAt = new Date(Date.now() + PORTAL_REFRESH_TOKEN_EXPIRY_MS);

  await db
    .update(portalUsersTable)
    .set({ refresh_token_hash: newHash, refresh_token_expires_at: expiresAt })
    .where(eq(portalUsersTable.id, portalUserId));

  const accessToken = generatePortalToken({
    id: user.id,
    lead_id: user.lead_id,
    firm_id: user.firm_id,
    email: user.email,
    name: user.name,
    tv: user.token_version,
  });

  return { accessToken, refreshToken: newPlaintext };
}

export async function revokePortalTokens(portalUserId: number): Promise<void> {
  await db
    .update(portalUsersTable)
    .set({
      token_version: sql`token_version + 1`,
      refresh_token_hash: null,
      refresh_token_expires_at: null,
    })
    .where(eq(portalUsersTable.id, portalUserId));
}

// =============================================================================
// Portal user provisioning — called by the background-check pass handler (Step 4)
// =============================================================================

export async function createPortalUserForLead(opts: {
  lead_id: number;
  firm_id: number;
  email: string;
  name: string;
}): Promise<{ signupToken: string }> {
  const { plaintext, hash } = generateOpaqueToken();
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24 hours

  // Upsert — idempotent so the background-check handler can retry safely.
  await db
    .insert(portalUsersTable)
    .values({
      lead_id: opts.lead_id,
      firm_id: opts.firm_id,
      email: opts.email,
      name: opts.name,
      signup_token_hash: hash,
      signup_token_expires_at: expiresAt,
    })
    .onConflictDoUpdate({
      target: portalUsersTable.lead_id,
      set: {
        signup_token_hash: hash,
        signup_token_expires_at: expiresAt,
        updated_at: new Date(),
      },
    });

  return { signupToken: plaintext };
}

// =============================================================================
// Portal audit log
// =============================================================================

export async function writePortalAudit(opts: {
  portal_user_id?: number | null;
  admin_user_id?: number | null;
  lead_id?: number | null;
  firm_id: number;
  action: string;
  resource_type?: string;
  resource_id?: number;
  ip?: string;
  user_agent?: string;
  metadata?: Record<string, unknown>;
}): Promise<void> {
  try {
    await db.insert(portalAuditLogTable).values({
      portal_user_id: opts.portal_user_id ?? null,
      admin_user_id: opts.admin_user_id ?? null,
      lead_id: opts.lead_id ?? null,
      firm_id: opts.firm_id,
      action: opts.action,
      resource_type: opts.resource_type ?? null,
      resource_id: opts.resource_id ?? null,
      ip_address: opts.ip ?? null,
      user_agent: opts.user_agent ?? null,
      metadata: opts.metadata ?? {},
    });
  } catch (err) {
    // Audit write failures must not break requests — BAA requires best-effort.
    logger.error({ err, action: opts.action }, "portal_audit_log write failed");
  }
}

// =============================================================================
// Misc helpers
// =============================================================================

export function getClientIp(req: Request): string {
  return (
    (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim() ||
    req.socket.remoteAddress ||
    "unknown"
  );
}

export function tortTypeToSlug(tortType: string): string {
  return tortType
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

export function getPortalBaseUrl(): string {
  return process.env.CLIENT_PORTAL_BASE_URL ?? "http://localhost:5174";
}
