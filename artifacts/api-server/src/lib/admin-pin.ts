/**
 * Admin PIN gate — the second-factor "sudo mode" for super-admin actions.
 *
 * MTOS runs a single privileged tier (every account has admin capacity)
 * with super_admin as the elevated unlock tier above it. This module
 * implements the gate: super_admins enter a per-user PIN to unlock admin
 * functions for the session.
 *
 *   - Stock PIN is "1234". A super_admin whose admin_pin_hash is NULL is
 *     still on the stock value — the unlock endpoint forces them to set a
 *     new PIN on first use. After change, "1234" no longer unlocks them.
 *   - The PIN is stored only as a salted scrypt hash (same shape as the
 *     password hash); never returned, never logged.
 *   - Successful unlock mints a 1-hour signed JWT ("admin-unlock token")
 *     keyed to the user. The Express middleware `requireAdminUnlock`
 *     checks for it in the X-Admin-Unlock header. Mounted in front of
 *     the admin-area routers, this is the backend enforcement of the gate.
 *
 * The gate stands on top of the existing role check: a non-super_admin
 * who somehow held an unlock token would still 403 at the role gate.
 * Both must agree.
 */
import crypto from "node:crypto";
import jwt from "jsonwebtoken";
import type { Request, Response, NextFunction } from "express";
import { __internal_markGateMiddleware as markGateMiddleware } from "./route-protection";

export const STOCK_PIN = "1234";
const ADMIN_UNLOCK_TTL_MIN = 60;

/** Sign / verify use SESSION_SECRET — same derivation as rbac.ts's JWT_SECRET. */
function resolveJwtSecret(): string {
  const s = process.env["SESSION_SECRET"];
  if (s) return s;
  // Match the rbac.ts dev fallback so admin-unlock tokens minted here
  // verify with the same secret rbac.ts uses for access tokens.
  return "mtos-dev-secret";
}

/** Shape check: digit-only, 4–8 characters. Stock 1234 satisfies this. */
export function isValidPinShape(pin: unknown): pin is string {
  return typeof pin === "string" && /^\d{4,8}$/.test(pin);
}

/** Hash a PIN with scrypt + a 16-byte salt; stored as `${salt}:${hex}`. */
export async function hashPin(pin: string): Promise<string> {
  const salt = crypto.randomBytes(16).toString("hex");
  return new Promise((resolve, reject) => {
    crypto.scrypt(pin, salt, 64, (err, derived) => {
      if (err) return reject(err);
      resolve(`${salt}:${derived.toString("hex")}`);
    });
  });
}

/**
 * Verify a plaintext PIN against a stored hash. Fails closed on any
 * malformed stored value. When `stored` is null the account is still on
 * the stock value — `STOCK_PIN` is the only string that verifies.
 */
export async function verifyPin(pin: string, stored: string | null): Promise<boolean> {
  if (!stored) return pin === STOCK_PIN;
  if (typeof stored !== "string" || stored.length === 0) return false;
  const idx = stored.indexOf(":");
  if (idx <= 0 || idx === stored.length - 1) return false;
  const salt = stored.slice(0, idx);
  const hex = stored.slice(idx + 1);
  if (hex.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(hex)) return false;
  const expected = Buffer.from(hex, "hex");
  if (expected.length !== 64) return false;
  return new Promise((resolve, reject) => {
    crypto.scrypt(pin, salt, 64, (err, derived) => {
      if (err) return reject(err);
      resolve(crypto.timingSafeEqual(expected, derived));
    });
  });
}

/** A stored PIN of null means the account is still on the stock 1234. */
export function isOnStockPin(stored: string | null | undefined): boolean {
  return !stored;
}

/** Mint a 1-hour admin-unlock token bound to one user. */
export function mintAdminUnlockToken(userId: number): { token: string; expiresInSec: number } {
  const expiresInSec = ADMIN_UNLOCK_TTL_MIN * 60;
  const token = jwt.sign(
    { kind: "admin_unlock", sub: userId },
    resolveJwtSecret(),
    { expiresIn: `${ADMIN_UNLOCK_TTL_MIN}m`, algorithm: "HS256" },
  );
  return { token, expiresInSec };
}

/** Verify an admin-unlock token is valid AND bound to this user. */
export function verifyAdminUnlockToken(token: string, userId: number): boolean {
  try {
    const decoded = jwt.verify(token, resolveJwtSecret(), { algorithms: ["HS256"] }) as {
      kind?: string;
      sub?: number;
    };
    return decoded.kind === "admin_unlock" && decoded.sub === userId;
  } catch {
    return false;
  }
}

/**
 * Express middleware: gate admin-area routers/routes behind a valid
 * admin-unlock token. Use AFTER authMiddleware (it reads req.user).
 *
 * The gate enforces two things:
 *   1. The caller must be super_admin (role check) — regular admin
 *      capacity is not enough for sudo-mode actions.
 *   2. A valid, non-expired admin-unlock token bound to their user.id
 *      must be in the X-Admin-Unlock header.
 */
export const requireAdminUnlock = markGateMiddleware(function requireAdminUnlock(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const user = req.user;
  if (!user) {
    res.status(401).json({
      status: "error",
      code: "UNAUTHENTICATED",
      message: "Authentication required",
    });
    return;
  }
  if (user.role !== "super_admin") {
    res.status(403).json({
      status: "error",
      code: "super_admin_only",
      message: "This action is restricted to super administrators.",
    });
    return;
  }
  const headerRaw = req.headers["x-admin-unlock"];
  const token = Array.isArray(headerRaw) ? headerRaw[0] : headerRaw;
  if (!token || typeof token !== "string") {
    res.status(401).json({
      status: "error",
      code: "admin_locked",
      message: "Admin functions are locked. Enter your admin PIN to unlock.",
    });
    return;
  }
  if (!verifyAdminUnlockToken(token, user.id)) {
    res.status(401).json({
      status: "error",
      code: "admin_locked",
      message: "Your admin unlock has expired. Re-enter your PIN.",
    });
    return;
  }
  next();
});
