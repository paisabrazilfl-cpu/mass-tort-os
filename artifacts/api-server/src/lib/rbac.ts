import { type Request, type Response, type NextFunction } from "express";
import jwt from "jsonwebtoken";
import crypto from "crypto";
import { db, refreshTokensTable } from "@workspace/db";
import { sql, eq, and, lt } from "drizzle-orm";
import { logger } from "./logger";
import { auditLog } from "./audit";

const JWT_SECRET = (() => {
  const secret = process.env.SESSION_SECRET;
  const env = process.env.NODE_ENV;
  if ((env === "production" || env === "staging") && !secret) {
    throw new Error("FATAL: SESSION_SECRET environment variable is required in production/staging");
  }
  return secret || "mtos-dev-secret";
})();
const ACCESS_TOKEN_EXPIRY = "15m";
const REFRESH_TOKEN_EXPIRY_MS = 7 * 24 * 60 * 60 * 1000;

export type UserRole = "admin" | "attorney" | "paralegal" | "viewer";

export interface AuthUser {
  id: number;
  email: string;
  name: string;
  role: UserRole;
  token_version?: number;
}

declare global {
  namespace Express {
    interface Request {
      user?: AuthUser;
    }
  }
}

const ROLE_HIERARCHY: Record<UserRole, number> = {
  admin: 100,
  attorney: 75,
  paralegal: 50,
  viewer: 25,
};

export function generateToken(user: AuthUser): string {
  return jwt.sign(
    { id: user.id, email: user.email, name: user.name, role: user.role, tv: user.token_version ?? 0 },
    JWT_SECRET,
    { expiresIn: ACCESS_TOKEN_EXPIRY }
  );
}

export async function generateRefreshToken(userId: number): Promise<string> {
  const token = crypto.randomBytes(48).toString("hex");
  const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
  const expiresAt = new Date(Date.now() + REFRESH_TOKEN_EXPIRY_MS);

  await db.insert(refreshTokensTable).values({
    user_id: userId,
    token_hash: tokenHash,
    expires_at: expiresAt,
    revoked: false,
  });

  return token;
}

export async function rotateRefreshToken(oldToken: string, userId: number): Promise<{ accessToken: string; refreshToken: string } | null> {
  const oldHash = crypto.createHash("sha256").update(oldToken).digest("hex");

  const [existing] = await db.select().from(refreshTokensTable)
    .where(and(
      eq(refreshTokensTable.token_hash, oldHash),
      eq(refreshTokensTable.user_id, userId),
    ));

  if (!existing || new Date() > existing.expires_at) {
    return null;
  }

  if (existing.revoked) {
    await db.update(refreshTokensTable)
      .set({ revoked: true })
      .where(eq(refreshTokensTable.user_id, userId));
    await db.execute(sql`
      UPDATE mtos_users SET token_version = token_version + 1 WHERE id = ${userId}
    `);
    logger.warn({ userId }, "Refresh token reuse detected — revoking ALL tokens for user");
    const { dispatchCriticalAlert } = await import("./security-alerts");
    dispatchCriticalAlert("critical", "Refresh token reuse detected", `User ${userId}: possible token theft — all sessions revoked`).catch(() => {});
    return null;
  }

  const newToken = crypto.randomBytes(48).toString("hex");
  const newHash = crypto.createHash("sha256").update(newToken).digest("hex");

  await db.update(refreshTokensTable)
    .set({ revoked: true, replaced_by: newHash })
    .where(eq(refreshTokensTable.id, existing.id));

  await db.insert(refreshTokensTable).values({
    user_id: userId,
    token_hash: newHash,
    expires_at: new Date(Date.now() + REFRESH_TOKEN_EXPIRY_MS),
    revoked: false,
  });

  const user = await getUserById(userId);
  if (!user) return null;

  return {
    accessToken: generateToken(user),
    refreshToken: newToken,
  };
}

export async function revokeAllUserTokens(userId: number): Promise<void> {
  await db.update(refreshTokensTable)
    .set({ revoked: true })
    .where(eq(refreshTokensTable.user_id, userId));

  await db.execute(sql`
    UPDATE mtos_users SET token_version = token_version + 1 WHERE id = ${userId}
  `);
}

export function verifyToken(token: string): (AuthUser & { tv?: number }) | null {
  try {
    return jwt.verify(token, JWT_SECRET, { algorithms: ["HS256"] }) as AuthUser & { tv?: number };
  } catch {
    return null;
  }
}

export async function authMiddleware(req: Request, res: Response, next: NextFunction): Promise<void> {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith("Bearer ")) {
    if (process.env.NODE_ENV !== "production" && process.env.NODE_ENV !== "staging") {
      logger.warn("Dev-mode auth bypass active — DO NOT use in production");
      req.user = { id: 0, email: "dev@mtos.local", name: "Dev Admin", role: "admin" };
      next();
      return;
    }
    res.status(401).json({ error: "Authentication required" });
    return;
  }

  const token = authHeader.slice(7);
  const decoded = verifyToken(token);
  if (!decoded) {
    res.status(401).json({ error: "Invalid or expired token" });
    return;
  }

  try {
    const rows = await db.execute(sql`
      SELECT token_version FROM mtos_users WHERE id = ${decoded.id} LIMIT 1
    `);
    const row = (Array.isArray(rows) ? rows : (rows as any).rows ?? [])[0] as any;
    if (!row) {
      res.status(401).json({ error: "User account not found" });
      return;
    }
    if (typeof decoded.tv === "number" && decoded.tv < (row.token_version ?? 0)) {
      res.status(401).json({ error: "Token has been revoked" });
      return;
    }
  } catch {
    logger.error("Token version check failed — denying request (fail-closed)");
    res.status(503).json({ error: "Authentication service temporarily unavailable" });
    return;
  }

  req.user = { id: decoded.id, email: decoded.email, name: decoded.name, role: decoded.role };
  next();
}

export function requireRole(...roles: UserRole[]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const user = req.user;
    if (!user) {
      res.status(401).json({ error: "Authentication required" });
      return;
    }

    if (roles.includes(user.role)) {
      next();
      return;
    }

    const userLevel = ROLE_HIERARCHY[user.role] || 0;
    const minRequired = Math.min(...roles.map(r => ROLE_HIERARCHY[r] || 0));
    if (userLevel >= minRequired) {
      next();
      return;
    }

    auditLog("access_denied", String(user.id), "unauthorized_access", {
      required_roles: roles,
      user_role: user.role,
      path: req.path,
      method: req.method,
    });

    res.status(403).json({ error: "Insufficient permissions" });
  };
}

export function auditAction(action: string) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const user = req.user;
    if (user) {
      auditLog("user_action", String(user.id), action, {
        path: req.path,
        method: req.method,
        user_email: user.email,
        user_role: user.role,
      }, {
        ip_address: (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim() || req.socket.remoteAddress,
        user_agent: req.headers["user-agent"],
      });
    }
    next();
  };
}

export async function createUser(email: string, name: string, role: UserRole, passwordHash: string): Promise<AuthUser> {
  const result = await db.execute(sql`
    INSERT INTO mtos_users (email, name, role, password_hash)
    VALUES (${email}, ${name}, ${role}, ${passwordHash})
    RETURNING id, email, name, role, token_version
  `);
  const rows = Array.isArray(result) ? result : (result as any).rows ?? [result];
  return rows[0] as unknown as AuthUser;
}

export async function getUserByEmail(email: string): Promise<(AuthUser & { password_hash: string; mfa_enabled: boolean; totp_secret: string | null; failed_login_attempts: number; locked_until: Date | null; token_version: number }) | null> {
  const rows = await db.execute(sql`
    SELECT id, email, name, role, password_hash, mfa_enabled, totp_secret, failed_login_attempts, locked_until, token_version
    FROM mtos_users WHERE email = ${email} LIMIT 1
  `);
  const result = Array.isArray(rows) ? rows : (rows as any).rows ?? [];
  if (!result.length) return null;
  return result[0] as any;
}

export async function getUserById(id: number): Promise<AuthUser | null> {
  const rows = await db.execute(sql`
    SELECT id, email, name, role, token_version FROM mtos_users WHERE id = ${id} LIMIT 1
  `);
  const result = Array.isArray(rows) ? rows : (rows as any).rows ?? [];
  if (!result.length) return null;
  return result[0] as unknown as AuthUser;
}

export async function listUsers(): Promise<AuthUser[]> {
  const rows = await db.execute(sql`SELECT id, email, name, role FROM mtos_users ORDER BY id`);
  return (Array.isArray(rows) ? rows : (rows as any).rows ?? []) as unknown as AuthUser[];
}

export async function incrementFailedAttempts(email: string): Promise<{ attempts: number; locked: boolean }> {
  const MAX_ATTEMPTS = 5;
  const LOCKOUT_MINUTES = 15;

  const rows = await db.execute(sql`
    UPDATE mtos_users
    SET failed_login_attempts = failed_login_attempts + 1,
        locked_until = CASE
          WHEN failed_login_attempts + 1 >= ${MAX_ATTEMPTS}
          THEN NOW() + INTERVAL '${sql.raw(String(LOCKOUT_MINUTES))} minutes'
          ELSE locked_until
        END,
        updated_at = NOW()
    WHERE email = ${email}
    RETURNING failed_login_attempts, locked_until
  `);
  const result = (Array.isArray(rows) ? rows : (rows as any).rows ?? [])[0] as any;
  if (!result) return { attempts: 0, locked: false };
  return {
    attempts: result.failed_login_attempts,
    locked: result.locked_until && new Date(result.locked_until) > new Date(),
  };
}

export async function resetFailedAttempts(email: string): Promise<void> {
  await db.execute(sql`
    UPDATE mtos_users SET failed_login_attempts = 0, locked_until = NULL, updated_at = NOW()
    WHERE email = ${email}
  `);
}

export async function isAccountLocked(user: { locked_until: Date | null; failed_login_attempts: number }): Promise<boolean> {
  if (!user.locked_until) return false;
  return new Date(user.locked_until) > new Date();
}

export async function cleanupExpiredTokens(): Promise<void> {
  try {
    await db.delete(refreshTokensTable)
      .where(lt(refreshTokensTable.expires_at, new Date()));
  } catch {
    logger.warn("Refresh token cleanup failed");
  }
}
