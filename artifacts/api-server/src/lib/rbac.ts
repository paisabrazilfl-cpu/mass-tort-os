import { type Request, type Response, type NextFunction } from "express";
import jwt from "jsonwebtoken";
import crypto from "crypto";
import { db, refreshTokensTable } from "@workspace/db";
import { sql, eq, and, lt } from "drizzle-orm";
import { logger } from "./logger";
import { auditLog } from "./audit";
import { unauthorized as sendUnauthorized, forbidden as sendForbidden } from "./http-errors";
import {
  __internal_markAuthMiddleware as markAuthMiddleware,
  __internal_markGateMiddleware as markGateMiddleware,
} from "./route-protection";

/**
 * Single source of truth for RBAC.
 *
 * Hard rules:
 *  1. Dev auth bypass fires ONLY when NODE_ENV === "development".
 *  2. SESSION_SECRET is required in production/staging; the dev fallback is
 *     only reachable when NODE_ENV === "development".
 *  3. Per-row ownership bypass goes through {@link canBypassOwnership} — no
 *     `user.id !== 0` god-mode special-case.
 *  4. Every 401/403 path emits the canonical envelope and writes an
 *     audit_log row through {@link auditDenial}.
 */

const NODE_ENV = process.env.NODE_ENV;
const IS_DEV = NODE_ENV === "development";
const IS_PROD_LIKE = NODE_ENV === "production" || NODE_ENV === "staging";

const JWT_SECRET = (() => {
  const secret = process.env.SESSION_SECRET;
  if (IS_PROD_LIKE && !secret) {
    throw new Error("FATAL: SESSION_SECRET environment variable is required in production/staging");
  }
  if (!secret && !IS_DEV) {
    throw new Error(`FATAL: SESSION_SECRET is required when NODE_ENV="${NODE_ENV ?? ""}" (only NODE_ENV="development" gets the fallback)`);
  }
  return secret || "mtos-dev-secret";
})();

/**
 * drizzle-orm/node-postgres' `db.execute()` resolves to a pg `QueryResult`
 * whose row array lives on `.rows`. The few callsites in this file that
 * speak raw SQL go through this helper so we don't sprinkle `as any`
 * casts at every single one.
 */
interface PgQueryResultLike<T> {
  rows: T[];
}

function rowsOf<T extends Record<string, unknown>>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  if (result && typeof result === "object" && "rows" in (result as object)) {
    const rows = (result as PgQueryResultLike<T>).rows;
    return Array.isArray(rows) ? rows : [];
  }
  return [];
}

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

/**
 * Strict ranking. Higher number = more privilege. requireRole() and
 * canBypassOwnership() consume this — we deliberately do NOT also keep an
 * "exact role list" branch (an old dual implementation used to drift).
 */
const ROLE_HIERARCHY: Record<UserRole, number> = {
  admin: 100,
  attorney: 75,
  paralegal: 50,
  viewer: 25,
};

// =============================================================================
// Permission catalogue
// =============================================================================

/**
 * Fine-grained capabilities. A handler that needs a specific power should
 * call {@link requirePermission} with the constant from this enum instead of
 * naming a role directly — that way reassigning a permission is a one-line
 * change in {@link ROLE_PERMISSIONS}.
 */
export const Permission = {
  // Lead lifecycle
  LEAD_VIEW_ANY: "lead:view:any",
  LEAD_VIEW_OWN: "lead:view:own",
  LEAD_CREATE: "lead:create",
  LEAD_UPDATE: "lead:update",
  LEAD_DELETE: "lead:delete",
  LEAD_QUALIFY: "lead:qualify",
  LEAD_EXPORT: "lead:export",

  // Cases
  CASE_VIEW_ANY: "case:view:any",
  CASE_VIEW_OWN: "case:view:own",
  CASE_CREATE: "case:create",
  CASE_UPLOAD: "case:upload",
  CASE_ANALYZE: "case:analyze",
  CASE_WORKER_ADMIN: "case:worker_admin",

  // Paralegals
  PARALEGAL_VIEW: "paralegal:view",
  PARALEGAL_MANAGE: "paralegal:manage",

  // Forms
  FORMS_CONFIG_VIEW_PUBLIC: "forms:config:view:public",
  FORMS_CONFIG_MANAGE: "forms:config:manage",

  // Decision engine
  DECISION_ENGINE_MANAGE: "decision_engine:manage",

  // Security & compliance
  SECURITY_MANAGE: "security:manage",
  COMPLIANCE_VIEW: "compliance:view",

  // Buyers / vendors / lead-sources / templates / workflow-settings
  BUYERS_VIEW: "buyers:view",
  BUYERS_MANAGE: "buyers:manage",
  VENDORS_VIEW: "vendors:view",
  VENDORS_MANAGE: "vendors:manage",
  LEAD_SOURCES_VIEW: "lead_sources:view",
  LEAD_SOURCES_MANAGE: "lead_sources:manage",
  TEMPLATES_VIEW: "templates:view",
  TEMPLATES_MANAGE: "templates:manage",
  WORKFLOW_SETTINGS_VIEW: "workflow_settings:view",
  WORKFLOW_SETTINGS_MANAGE: "workflow_settings:manage",

  // Integrations
  INTEGRATIONS_MANAGE: "integrations:manage",

  // User admin
  USERS_LIST: "users:list",
} as const;

export type Permission = (typeof Permission)[keyof typeof Permission];

/**
 * Role → permission set. THE single place this mapping is declared.
 *
 * Inheritance is not implicit — admin gets every permission explicitly so a
 * new permission added below cannot accidentally land in admin's bag without
 * a code review touching this map.
 */
export const ROLE_PERMISSIONS: Record<UserRole, ReadonlySet<Permission>> = {
  admin: new Set<Permission>(Object.values(Permission)),
  attorney: new Set<Permission>([
    Permission.LEAD_VIEW_ANY,
    Permission.LEAD_CREATE,
    Permission.LEAD_UPDATE,
    Permission.LEAD_DELETE,
    Permission.LEAD_QUALIFY,
    Permission.LEAD_EXPORT,
    Permission.CASE_VIEW_ANY,
    Permission.CASE_CREATE,
    Permission.CASE_UPLOAD,
    Permission.CASE_ANALYZE,
    Permission.PARALEGAL_VIEW,
    Permission.FORMS_CONFIG_VIEW_PUBLIC,
    Permission.BUYERS_VIEW,
    Permission.VENDORS_VIEW,
    Permission.VENDORS_MANAGE,
    Permission.LEAD_SOURCES_VIEW,
    Permission.TEMPLATES_VIEW,
    Permission.WORKFLOW_SETTINGS_VIEW,
  ]),
  paralegal: new Set<Permission>([
    Permission.LEAD_VIEW_OWN,
    Permission.LEAD_CREATE,
    Permission.LEAD_UPDATE,
    Permission.LEAD_QUALIFY,
    Permission.CASE_VIEW_OWN,
    Permission.CASE_CREATE,
    Permission.CASE_UPLOAD,
    Permission.CASE_ANALYZE,
    Permission.FORMS_CONFIG_VIEW_PUBLIC,
    Permission.VENDORS_VIEW,
    Permission.LEAD_SOURCES_VIEW,
    Permission.TEMPLATES_VIEW,
    Permission.WORKFLOW_SETTINGS_VIEW,
  ]),
  viewer: new Set<Permission>([
    Permission.LEAD_VIEW_OWN,
    Permission.CASE_VIEW_OWN,
    Permission.FORMS_CONFIG_VIEW_PUBLIC,
    Permission.BUYERS_VIEW,
    Permission.LEAD_SOURCES_VIEW,
    Permission.TEMPLATES_VIEW,
    Permission.WORKFLOW_SETTINGS_VIEW,
  ]),
};

// =============================================================================
// Capability helpers
// =============================================================================

export function hasPermission(user: AuthUser | undefined | null, permission: Permission): boolean {
  if (!user) return false;
  const perms = ROLE_PERMISSIONS[user.role];
  return perms ? perms.has(permission) : false;
}

/**
 * Returns true iff the caller may bypass per-row ownership checks (e.g.
 * read leads they did not create / are not assigned to).
 *
 * This REPLACES every `user.id !== 0` check that used to sprinkle the routes
 * — that pattern was a dev-mode escape hatch that incorrectly granted
 * ownership-bypass to the synthetic `id=0` dev user but to no real account.
 * Bypass authority now flows from role only.
 */
export function canBypassOwnership(user: AuthUser | undefined | null): boolean {
  if (!user) return false;
  return user.role === "admin" || user.role === "attorney";
}

// =============================================================================
// Token plumbing (unchanged)
// =============================================================================

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

/**
 * Pure helper extracted so the token-version revocation check is unit-testable
 * without mocking the database. The contract:
 *
 *   - If the token doesn't carry a `tv` claim (legacy tokens issued before
 *     token_version was added), we don't revoke — the caller must rely on
 *     normal JWT expiry.
 *   - If the token's `tv` is strictly less than the current DB value, the
 *     token was issued before a `revokeAllUserTokens(userId)` call bumped
 *     the user's version, so it must be rejected as revoked.
 *   - Equal values pass — that's the normal case for live tokens.
 *
 * This is exercised end-to-end at runtime by `_authMiddleware`, and asserted
 * directly by the role × route test matrix.
 */
export function isTokenVersionRevoked(decodedTv: number | undefined, currentDbTv: number | undefined): boolean {
  if (typeof decodedTv !== "number") return false;
  const current = currentDbTv ?? 0;
  return decodedTv < current;
}

// =============================================================================
// authMiddleware
// =============================================================================

/**
 * Global authentication. Fails closed in prod/staging/test/anything-not-dev.
 * The dev bypass fires only when NODE_ENV === "development" AND no
 * Authorization header is present — token-bearing requests always verify.
 */
async function _authMiddleware(req: Request, res: Response, next: NextFunction): Promise<void> {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith("Bearer ")) {
    if (IS_DEV) {
      logger.warn({ path: req.path }, "Dev-mode auth bypass active — DO NOT use in production");
      req.user = { id: 0, email: "dev@mtos.local", name: "Dev Admin", role: "admin" };
      next();
      return;
    }
    auditDenial(req, "missing_credentials");
    sendUnauthorized(res, "Authentication required");
    return;
  }

  const token = authHeader.slice(7);
  const decoded = verifyToken(token);
  if (!decoded) {
    auditDenial(req, "invalid_or_expired_token");
    sendUnauthorized(res, "Invalid or expired token");
    return;
  }

  try {
    const result = await db.execute(sql`
      SELECT token_version FROM mtos_users WHERE id = ${decoded.id} LIMIT 1
    `);
    const row = rowsOf<{ token_version: number }>(result)[0];
    if (!row) {
      auditDenial(req, "user_account_not_found", { decoded });
      sendUnauthorized(res, "User account not found");
      return;
    }
    if (isTokenVersionRevoked(decoded.tv, row.token_version)) {
      auditDenial(req, "token_revoked", { decoded });
      sendUnauthorized(res, "Token has been revoked");
      return;
    }
  } catch {
    // Fail closed: a DB outage during token-version check must NOT silently
    // grant access — return 503 so the client can retry.
    logger.error("Token version check failed — denying request (fail-closed)");
    res.status(503).json({
      status: "error",
      code: "AUTH_UNAVAILABLE",
      message: "Authentication service temporarily unavailable",
    });
    return;
  }

  req.user = { id: decoded.id, email: decoded.email, name: decoded.name, role: decoded.role };
  next();
}

export const authMiddleware = markAuthMiddleware(_authMiddleware);

// =============================================================================
// requireRole / requirePermission
// =============================================================================

/**
 * Requires the caller hold one of `roles` or a higher role per
 * {@link ROLE_HIERARCHY}. Pass the LOWEST role that is acceptable.
 */
export function requireRole(...roles: UserRole[]) {
  if (roles.length === 0) {
    throw new Error("requireRole called with no roles — refusing to mount a deny-all middleware");
  }
  const minRequired = Math.min(...roles.map(r => ROLE_HIERARCHY[r]));
  const minLabel = (Object.keys(ROLE_HIERARCHY) as UserRole[]).find(r => ROLE_HIERARCHY[r] === minRequired) ?? roles[0];
  return markGateMiddleware(function requireRole(req: Request, res: Response, next: NextFunction): void {
    const user = req.user;
    if (!user) {
      auditDenial(req, "unauthenticated_role_check", { required_roles: roles });
      sendUnauthorized(res, "Authentication required");
      return;
    }
    const userLevel = ROLE_HIERARCHY[user.role] ?? 0;
    if (userLevel >= minRequired) {
      next();
      return;
    }
    auditDenial(req, "insufficient_role", { required_roles: roles });
    sendForbidden(res, "Insufficient permissions");
  }, { kind: "role", values: [minLabel] });
}

/**
 * Permission-gated middleware. Variadic — the gate accepts iff the caller
 * holds AT LEAST ONE of the listed permissions (any-of). Passing zero
 * permissions throws at mount time so misconfiguration surfaces at boot.
 */
export function requirePermission(...permissions: Permission[]) {
  if (permissions.length === 0) {
    throw new Error("requirePermission called with no permissions — refusing to mount a deny-all middleware");
  }
  return markGateMiddleware(function requirePermission(req: Request, res: Response, next: NextFunction): void {
    const user = req.user;
    if (!user) {
      auditDenial(req, "unauthenticated_permission_check", { required_permissions: permissions });
      sendUnauthorized(res, "Authentication required");
      return;
    }
    if (permissions.some((p) => hasPermission(user, p))) {
      next();
      return;
    }
    auditDenial(req, "missing_permission", { required_permissions: permissions });
    sendForbidden(res, "Insufficient permissions");
  }, { kind: "permission", values: permissions });
}

// =============================================================================
// Audit & user CRUD
// =============================================================================

/**
 * Options accepted by {@link auditDenial}. Every denial path in this module
 * funnels through that helper so the SOC audit trail is uniform.
 */
interface AuditDenialOpts {
  /** Roles the gate required (any-of). Empty for unauth/missing-token paths. */
  required_roles?: readonly UserRole[];
  /** Permissions the gate required (any-of). Empty for unauth/missing-token paths. */
  required_permissions?: readonly Permission[];
  /** Decoded JWT for paths where req.user has not been populated yet
   *  (user_account_not_found / token_revoked). */
  decoded?: { id: number; email: string; role: UserRole };
  /** Per-route ownership metadata (case_id, lead_id, owner_user_id, …). */
  extra?: Record<string, unknown>;
}

/**
 * Canonical 401/403 audit-log writer.
 *
 * EVERY denial — anonymous, missing token, expired token, revoked token,
 * insufficient role, missing permission, ownership violation — produces an
 * audit_log row with the same payload shape:
 *
 *   {
 *     reason, path, method,
 *     user_id, user_email, user_role,    // null when unknown
 *     required_roles[], required_permissions[],   // empty arrays default
 *     ip_address, user_agent,
 *     ...extra (per-route ownership metadata)
 *   }
 *
 * The shape is documented in docs/audits/rbac-remediation-2026-04-26.md §5.
 * Fire-and-forget; audit failures must NEVER turn a 401 into a 500.
 */
function auditDenial(req: Request, reason: string, opts: AuditDenialOpts = {}): void {
  const u = req.user;
  const userId = u?.id ?? opts.decoded?.id ?? null;
  const userEmail = u?.email ?? opts.decoded?.email ?? null;
  const userRole = u?.role ?? opts.decoded?.role ?? null;

  const subject = userId !== null ? String(userId) : "anonymous";
  const xff = req.headers["x-forwarded-for"];
  const ip = (Array.isArray(xff) ? xff[0] : xff)?.split(",")[0]?.trim() || req.socket.remoteAddress;

  auditLog("access_denied", subject, reason, {
    reason,
    path: req.path,
    method: req.method,
    user_id: userId,
    user_email: userEmail,
    user_role: userRole,
    required_roles: opts.required_roles ?? [],
    required_permissions: opts.required_permissions ?? [],
    ...(opts.extra ?? {}),
  }, {
    ip_address: ip,
    user_agent: req.headers["user-agent"],
  }).catch(() => {});
}

/**
 * Audited 403 helper for ownership / domain-rule denials inside route
 * handlers — writes an audit_log row and sends the canonical FORBIDDEN
 * envelope. Use anywhere a handler decides "right role, wrong row".
 */
export function denyForbidden(
  req: Request,
  res: Response,
  reason: string,
  message = "Insufficient permissions",
  extra?: Record<string, unknown>,
): void {
  auditDenial(req, reason, { extra });
  sendForbidden(res, message);
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
      }).catch(() => {});
    }
    next();
  };
}

type UserRow = AuthUser & Record<string, unknown>;
type UserCredentialsRow = AuthUser & {
  password_hash: string;
  mfa_enabled: boolean;
  totp_secret: string | null;
  failed_login_attempts: number;
  locked_until: Date | null;
  token_version: number;
};

export async function createUser(email: string, name: string, role: UserRole, passwordHash: string): Promise<AuthUser> {
  const result = await db.execute(sql`
    INSERT INTO mtos_users (email, name, role, password_hash)
    VALUES (${email}, ${name}, ${role}, ${passwordHash})
    RETURNING id, email, name, role, token_version
  `);
  const rows = rowsOf<UserRow>(result);
  return rows[0] as AuthUser;
}

export async function getUserByEmail(email: string): Promise<UserCredentialsRow | null> {
  const result = await db.execute(sql`
    SELECT id, email, name, role, password_hash, mfa_enabled, totp_secret, failed_login_attempts, locked_until, token_version
    FROM mtos_users WHERE email = ${email} LIMIT 1
  `);
  const rows = rowsOf<UserCredentialsRow>(result);
  return rows[0] ?? null;
}

export async function getUserById(id: number): Promise<AuthUser | null> {
  const result = await db.execute(sql`
    SELECT id, email, name, role, token_version FROM mtos_users WHERE id = ${id} LIMIT 1
  `);
  const rows = rowsOf<UserRow>(result);
  return rows[0] ? (rows[0] as AuthUser) : null;
}

export async function listUsers(): Promise<AuthUser[]> {
  const result = await db.execute(sql`SELECT id, email, name, role FROM mtos_users ORDER BY id`);
  return rowsOf<UserRow>(result) as AuthUser[];
}

export async function incrementFailedAttempts(email: string): Promise<{ attempts: number; locked: boolean }> {
  const MAX_ATTEMPTS = 5;
  const LOCKOUT_MINUTES = 15;

  const result = await db.execute(sql`
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
  const row = rowsOf<{ failed_login_attempts: number; locked_until: Date | null }>(result)[0];
  if (!row) return { attempts: 0, locked: false };
  return {
    attempts: row.failed_login_attempts,
    locked: row.locked_until !== null && new Date(row.locked_until) > new Date(),
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

// =============================================================================
// Test helpers (exported for the role × route matrix in __tests__/)
// =============================================================================

/** Internal: read-only view of dev-bypass status for the boot banner & tests. */
export const __rbacInternal = {
  isDev: () => IS_DEV,
  isProdLike: () => IS_PROD_LIKE,
  jwtSecretIsDevFallback: () => JWT_SECRET === "mtos-dev-secret",
  roleHierarchy: () => ({ ...ROLE_HIERARCHY }),
};
