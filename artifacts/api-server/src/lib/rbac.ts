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
import {
  isApiKeyToken,
  authenticateApiKey,
  checkScope,
  auditApiKeyRequest,
} from "./api-keys";

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

export type UserRole = "super_admin" | "admin" | "user_manager" | "attorney" | "paralegal" | "agent" | "viewer";

export interface AuthUser {
  id: number;
  email: string;
  name: string;
  role: UserRole;
  // Single-firm shell (Task #51 T001): every authenticated user is bound
  // to exactly one firm. Sourced from mtos_users.firm_id (NOT NULL FK)
  // and embedded in the JWT so downstream routes don't have to re-query.
  firm_id: number;
  token_version?: number;
}

export interface ReqFirm {
  id: number;
  name: string;
  slug: string;
  subscription_status: string | null;
  current_period_end: Date | null;
}

declare global {
  namespace Express {
    interface Request {
      user?: AuthUser;
      firm?: ReqFirm;
    }
  }
}

// Higher number = more privilege.
// super_admin  — platform owner only (paisabrazilfl@gmail.com). Sees all firms, all data.
// admin        — firm managing partner. Full control within their firm.
// user_manager — office/team manager. Manages users, invites, roles. Read-only on cases/leads.
// attorney     — full legal case authority.
// paralegal    — manages leads, cases, and documents.
// agent        — intake agent / call-center rep. Creates leads and works intake only.
// viewer       — read-only. Default for self-serve signups.
const ROLE_HIERARCHY: Record<UserRole, number> = {
  super_admin:  200,
  admin:        100,
  user_manager:  80,
  attorney:      75,
  paralegal:     50,
  agent:         35,
  viewer:        25,
};

// =============================================================================
// Permission catalogue
// =============================================================================

export const Permission = {
  // Lead lifecycle
  LEAD_VIEW_ANY: "lead:view:any",
  LEAD_VIEW_OWN: "lead:view:own",
  LEAD_CREATE: "lead:create",
  LEAD_UPDATE: "lead:update",
  LEAD_DELETE: "lead:delete",
  LEAD_QUALIFY: "lead:qualify",
  LEAD_EXPORT: "lead:export",

  // Lead import
  LEAD_IMPORT_PREVIEW: "lead_import:preview",
  LEAD_IMPORT_EXECUTE: "lead_import:execute",

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
  // FORMS_CONFIG_VIEW_PUBLIC is the redacted/public-facing form config
  // (held by every authenticated role); FORMS_CONFIG_VIEW is the full
  // internal config (attorney+ only).
  FORMS_CONFIG_VIEW_PUBLIC: "forms:config:view:public",
  FORMS_CONFIG_VIEW: "forms:config:view",
  FORMS_CONFIG_MANAGE: "forms:config:manage",
  FORMS_SUBMIT: "forms:submit",
  FORMS_BACKGROUND_CHECK: "forms:background_check",
  FORMS_NPI_VERIFY: "forms:npi_verify",
  FORMS_FRAUD_CHECK: "forms:fraud_check",
  FORMS_ESCALATE_FBI: "forms:escalate_fbi",

  // Decision engine
  DECISION_ENGINE_VIEW: "decision_engine:view",
  DECISION_ENGINE_MANAGE: "decision_engine:manage",

  // Security & compliance
  SECURITY_MANAGE: "security:manage",
  COMPLIANCE_VIEW: "compliance:view",

  // Buyers / vendors / lead-sources / templates / workflow-settings
  BUYERS_VIEW: "buyers:view",
  BUYERS_MANAGE: "buyers:manage",
  VENDORS_VIEW: "vendors:view",
  VENDORS_MANAGE: "vendors:manage",
  // Vendor delete is admin-only (sub-set of "manage" tier).
  VENDORS_DELETE: "vendors:delete",
  LEAD_SOURCES_VIEW: "lead_sources:view",
  LEAD_SOURCES_MANAGE: "lead_sources:manage",
  TEMPLATES_VIEW: "templates:view",
  TEMPLATES_MANAGE: "templates:manage",
  WORKFLOW_SETTINGS_VIEW: "workflow_settings:view",
  WORKFLOW_SETTINGS_MANAGE: "workflow_settings:manage",

  // Documents
  DOCUMENTS_VIEW: "documents:view",
  DOCUMENTS_CREATE: "documents:create",
  DOCUMENTS_UPDATE: "documents:update",
  DOCUMENTS_DELETE: "documents:delete",
  DOCUMENTS_REDACT: "documents:redact",

  // OCR
  OCR_UPLOAD: "ocr:upload",
  OCR_VIEW: "ocr:view",
  OCR_QUEUE_ADMIN: "ocr:queue_admin",
  OCR_AI_FIELDS: "ocr:ai_fields",

  // Drafting
  DRAFTING_TEMPLATES_VIEW: "drafting:templates_view",
  DRAFTING_GENERATE: "drafting:generate",

  // Image objects
  IMAGE_OBJECTS_VIEW: "image_objects:view",
  IMAGE_OBJECTS_MANAGE: "image_objects:manage",
  IMAGE_OBJECTS_DELETE: "image_objects:delete",

  // NPI / news / timeline / review-queue / dashboard / analytics
  NPI_LOOKUP: "npi:lookup",
  NEWS_VIEW: "news:view",
  TIMELINE_VIEW: "timeline:view",
  REVIEW_QUEUE_VIEW: "review_queue:view",
  REVIEW_QUEUE_RESOLVE: "review_queue:resolve",
  DASHBOARD_VIEW: "dashboard:view",
  ANALYTICS_VIEW: "analytics:view",
  ANALYTICS_PREDICTIVE_LEAD_VIEW: "analytics:predictive:lead",

  // Integrations
  INTEGRATIONS_MANAGE: "integrations:manage",

  // User admin
  USERS_LIST: "users:list",
  // Permission to mutate other users' role assignments (Task #58). Only
  // granted to the admin role via Object.values(Permission) below — we
  // never add this to attorney/paralegal/viewer because role-elevation is
  // a privileged operation that bypasses the registration default.
  USERS_MANAGE: "users:manage",

  // Firm invites — admin generates a one-time link bound to their firm
  // so a new self-serve registration lands in the right tenant instead
  // of falling back to the seeded default firm. Strictly admin-only.
  INVITES_MANAGE: "invites:manage",

  // Billing (Stripe)
  BILLING_MANAGE: "billing:manage",

  // Voice (Vapi call logs)
  CALLS_VIEW: "calls:view",
  CALLS_MANAGE: "calls:manage",

  // SMS (Telnyx outbound)
  SMS_SEND: "sms:send",

  // Automations (visual workflow engine)
  AUTOMATIONS_VIEW: "automations:view",
  AUTOMATIONS_MANAGE: "automations:manage",
  AUTOMATIONS_EXECUTE: "automations:execute",

  // Medical Records (Fasten Health patient-initiated FHIR import)
  MEDICAL_RECORDS_VIEW: "medical_records:view",
  MEDICAL_RECORDS_MANAGE: "medical_records:manage",

  // API keys (Task #52) — long-lived service-account tokens for n8n etc.
  // Admin-only. Keys are scoped per-resource so they're strictly LESS
  // privileged than admin sessions; the manage perm itself is the gate
  // on minting / revoking.
  API_KEYS_MANAGE: "api_keys:manage",

  // Self-Heal / Auto-Fix (Jules dispatch). Admin-only — pasted prompts
  // become coding-agent input that opens PRs against the repo.
  SELF_HEAL_MANAGE: "self_heal:manage",

  // Competitive Intelligence (Google Ads Transparency Center via SerpAPI).
  // Admin-only — surfaces what other plaintiff firms are advertising for.
  COMPETITIVE_INTEL_MANAGE: "competitive_intel:manage",

  // Config Snapshots — take / restore firm-scoped operational config snapshots.
  SNAPSHOT_MANAGE: "snapshot:manage",

  // AI Reranking — access to the AI-powered lead reranking endpoint.
  AI_RERANK: "ai:rerank",
} as const;

export type Permission = (typeof Permission)[keyof typeof Permission];

// Role → permission set. Admin gets every permission explicitly (no implicit
// inheritance) so new permissions cannot land in admin's bag without an
// explicit edit to this map. super_admin mirrors admin's full set and sits
// one step above in the hierarchy so requireRole("admin") gates pass.
export const ROLE_PERMISSIONS: Record<UserRole, ReadonlySet<Permission>> = {
  super_admin: new Set<Permission>(Object.values(Permission)),
  admin: new Set<Permission>(Object.values(Permission)),

  // ── user_manager ────────────────────────────────────────────────────────────
  // Team / office manager. Core job: invite users, assign roles, manage access.
  // Has read-only visibility into leads, cases, analytics, and compliance for
  // oversight — but cannot create, modify, or delete case-related records.
  user_manager: new Set<Permission>([
    // User administration — primary function
    Permission.USERS_LIST,
    Permission.USERS_MANAGE,
    Permission.INVITES_MANAGE,
    // Read-only lead/case oversight
    Permission.LEAD_VIEW_ANY,
    Permission.CASE_VIEW_OWN,
    // Paralegal roster (to assign leads)
    Permission.PARALEGAL_VIEW,
    // Forms oversight
    Permission.FORMS_CONFIG_VIEW_PUBLIC,
    Permission.FORMS_CONFIG_VIEW,
    // Decision engine visibility
    Permission.DECISION_ENGINE_VIEW,
    // Reference data (read-only)
    Permission.BUYERS_VIEW,
    Permission.VENDORS_VIEW,
    Permission.LEAD_SOURCES_VIEW,
    Permission.TEMPLATES_VIEW,
    Permission.WORKFLOW_SETTINGS_VIEW,
    // Documents (read-only)
    Permission.DOCUMENTS_VIEW,
    // Compliance / audit trail oversight
    Permission.COMPLIANCE_VIEW,
    // Analytics and reporting
    Permission.DASHBOARD_VIEW,
    Permission.ANALYTICS_VIEW,
    // News / timeline / review queue visibility
    Permission.NEWS_VIEW,
    Permission.TIMELINE_VIEW,
    Permission.REVIEW_QUEUE_VIEW,
    // Call monitoring (listen only)
    Permission.CALLS_VIEW,
  ]),

  attorney: new Set<Permission>([
    // Leads / lead-import
    Permission.LEAD_VIEW_ANY,
    Permission.LEAD_CREATE,
    Permission.LEAD_UPDATE,
    Permission.LEAD_DELETE,
    Permission.LEAD_QUALIFY,
    Permission.LEAD_EXPORT,
    Permission.LEAD_IMPORT_PREVIEW,
    Permission.LEAD_IMPORT_EXECUTE,
    // Cases
    Permission.CASE_VIEW_ANY,
    Permission.CASE_CREATE,
    Permission.CASE_UPLOAD,
    Permission.CASE_ANALYZE,
    // Paralegals
    Permission.PARALEGAL_VIEW,
    // Forms
    Permission.FORMS_CONFIG_VIEW_PUBLIC,
    Permission.FORMS_CONFIG_VIEW,
    Permission.FORMS_SUBMIT,
    Permission.FORMS_BACKGROUND_CHECK,
    Permission.FORMS_NPI_VERIFY,
    Permission.FORMS_FRAUD_CHECK,
    Permission.FORMS_ESCALATE_FBI,
    // Decision engine
    Permission.DECISION_ENGINE_VIEW,
    // Buyers / vendors / lead-sources / templates / workflow-settings
    Permission.BUYERS_VIEW,
    Permission.VENDORS_VIEW,
    Permission.VENDORS_MANAGE,
    Permission.LEAD_SOURCES_VIEW,
    Permission.TEMPLATES_VIEW,
    Permission.WORKFLOW_SETTINGS_VIEW,
    // Documents
    Permission.DOCUMENTS_VIEW,
    Permission.DOCUMENTS_CREATE,
    Permission.DOCUMENTS_UPDATE,
    Permission.DOCUMENTS_DELETE,
    Permission.DOCUMENTS_REDACT,
    // OCR
    Permission.OCR_UPLOAD,
    Permission.OCR_VIEW,
    Permission.OCR_AI_FIELDS,
    // Drafting
    Permission.DRAFTING_TEMPLATES_VIEW,
    Permission.DRAFTING_GENERATE,
    // Image objects (delete is admin-only)
    Permission.IMAGE_OBJECTS_VIEW,
    Permission.IMAGE_OBJECTS_MANAGE,
    // NPI / news / timeline / review-queue / dashboard / analytics
    Permission.NPI_LOOKUP,
    Permission.NEWS_VIEW,
    Permission.TIMELINE_VIEW,
    Permission.REVIEW_QUEUE_VIEW,
    Permission.REVIEW_QUEUE_RESOLVE,
    Permission.DASHBOARD_VIEW,
    Permission.ANALYTICS_VIEW,
    Permission.ANALYTICS_PREDICTIVE_LEAD_VIEW,
    // NOTE: BILLING_MANAGE is admin-only per spec (Task #51 T006). Attorney
    // does NOT get billing perms even though they own legal work for the firm.
    // Voice & SMS — attorney can review calls and send SMS to leads.
    Permission.CALLS_VIEW,
    Permission.CALLS_MANAGE,
    Permission.SMS_SEND,
    // Medical records (Fasten) — attorneys can issue connect links and trigger syncs.
    Permission.MEDICAL_RECORDS_VIEW,
    Permission.MEDICAL_RECORDS_MANAGE,
  ]),
  paralegal: new Set<Permission>([
    // Leads / lead-import (no delete/export, no execute)
    Permission.LEAD_VIEW_OWN,
    Permission.LEAD_CREATE,
    Permission.LEAD_UPDATE,
    Permission.LEAD_QUALIFY,
    Permission.LEAD_IMPORT_PREVIEW,
    // Cases
    Permission.CASE_VIEW_OWN,
    Permission.CASE_CREATE,
    Permission.CASE_UPLOAD,
    Permission.CASE_ANALYZE,
    // Forms (no FBI escalation, no internal config view)
    Permission.FORMS_CONFIG_VIEW_PUBLIC,
    Permission.FORMS_SUBMIT,
    Permission.FORMS_BACKGROUND_CHECK,
    Permission.FORMS_NPI_VERIFY,
    Permission.FORMS_FRAUD_CHECK,
    // Vendors / buyers / lead-sources / templates / workflow-settings
    Permission.VENDORS_VIEW,
    Permission.BUYERS_VIEW,
    Permission.LEAD_SOURCES_VIEW,
    Permission.TEMPLATES_VIEW,
    Permission.WORKFLOW_SETTINGS_VIEW,
    // Documents (no delete)
    Permission.DOCUMENTS_VIEW,
    Permission.DOCUMENTS_CREATE,
    Permission.DOCUMENTS_UPDATE,
    Permission.DOCUMENTS_REDACT,
    // OCR (no queue admin)
    Permission.OCR_UPLOAD,
    Permission.OCR_VIEW,
    Permission.OCR_AI_FIELDS,
    // Drafting
    Permission.DRAFTING_TEMPLATES_VIEW,
    Permission.DRAFTING_GENERATE,
    // Image objects (no delete)
    Permission.IMAGE_OBJECTS_VIEW,
    Permission.IMAGE_OBJECTS_MANAGE,
    // NPI / news / timeline / review-queue / dashboard / analytics-predictive
    Permission.NPI_LOOKUP,
    Permission.NEWS_VIEW,
    Permission.TIMELINE_VIEW,
    Permission.REVIEW_QUEUE_VIEW,
    Permission.DASHBOARD_VIEW,
    Permission.ANALYTICS_PREDICTIVE_LEAD_VIEW,
    // Voice & SMS — paralegals can listen to calls and send SMS follow-ups.
    Permission.CALLS_VIEW,
    Permission.SMS_SEND,
    // Medical records (Fasten) — paralegals issue connect links + run syncs day-to-day.
    Permission.MEDICAL_RECORDS_VIEW,
    Permission.MEDICAL_RECORDS_MANAGE,
  ]),
  // ── agent ───────────────────────────────────────────────────────────────────
  // Intake agent / call-center rep. Creates and works their own leads.
  // Cannot see other agents' leads, cannot access cases beyond their own,
  // cannot manage users or access admin functions.
  agent: new Set<Permission>([
    // Lead intake — primary function
    Permission.LEAD_CREATE,
    Permission.LEAD_VIEW_OWN,
    Permission.LEAD_UPDATE,
    // Forms / intake pipeline
    Permission.FORMS_CONFIG_VIEW_PUBLIC,
    Permission.FORMS_SUBMIT,
    Permission.FORMS_BACKGROUND_CHECK,
    Permission.FORMS_NPI_VERIFY,
    Permission.FORMS_FRAUD_CHECK,
    // Reference lookups
    Permission.NPI_LOOKUP,
    Permission.BUYERS_VIEW,
    Permission.LEAD_SOURCES_VIEW,
    // Own case visibility
    Permission.CASE_VIEW_OWN,
    // Documents on their own leads
    Permission.DOCUMENTS_VIEW,
    // Communication with leads
    Permission.CALLS_VIEW,
    Permission.SMS_SEND,
    // Dashboard / news / timeline (own records)
    Permission.DASHBOARD_VIEW,
    Permission.NEWS_VIEW,
    Permission.TIMELINE_VIEW,
  ]),

  viewer: new Set<Permission>([
    Permission.LEAD_VIEW_OWN,
    Permission.CASE_VIEW_OWN,
    Permission.FORMS_CONFIG_VIEW_PUBLIC,
    Permission.BUYERS_VIEW,
    Permission.LEAD_SOURCES_VIEW,
    Permission.TEMPLATES_VIEW,
    Permission.WORKFLOW_SETTINGS_VIEW,
    Permission.DOCUMENTS_VIEW,
    Permission.NEWS_VIEW,
    Permission.DASHBOARD_VIEW,
    // Voice — viewer can listen to recorded calls (read-only).
    // SMS_SEND is intentionally excluded; viewer cannot transmit.
    Permission.CALLS_VIEW,
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

// Returns true iff the caller may read/write rows they don't own (e.g. leads
// they did not create or aren't assigned to). Bypass flows from role only.
export function canBypassOwnership(user: AuthUser | undefined | null): boolean {
  if (!user) return false;
  return user.role === "super_admin" || user.role === "admin" || user.role === "attorney";
}

// =============================================================================
// Token plumbing (unchanged)
// =============================================================================

export function generateToken(user: AuthUser): string {
  return jwt.sign(
    {
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
      firm_id: user.firm_id,
      tv: user.token_version ?? 0,
    },
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

// Token is revoked iff its `tv` claim is strictly less than the user's current
// `token_version`. Legacy tokens without `tv` are not revoked here (rely on
// JWT expiry).
export function isTokenVersionRevoked(decodedTv: number | undefined, currentDbTv: number | undefined): boolean {
  if (typeof decodedTv !== "number") return false;
  const current = currentDbTv ?? 0;
  return decodedTv < current;
}

// =============================================================================
// authMiddleware
// =============================================================================

// Fails closed for any non-development NODE_ENV. Dev bypass fires only when
// NODE_ENV === "development" AND no Authorization header is present.
async function _authMiddleware(req: Request, res: Response, next: NextFunction): Promise<void> {
  const authHeader = req.headers.authorization;
  if (typeof authHeader !== "string" || authHeader.indexOf("Bearer ") !== 0) {
    // Task #20: dev bypass is now OPT-IN via MTOS_DEV_LOGIN=1 even under
    // NODE_ENV=development. Without this flag, the dev login UI exercises
    // the real /auth/login + /auth/refresh JWT path, so MFA, lockout, and
    // token-version revocation can be smoke-tested in the same loop the
    // user runs locally. NODE_ENV=production still fails closed regardless.
    if (IS_DEV && process.env.MTOS_DEV_LOGIN === "1") {
      logger.warn({ path: req.path }, "Dev-mode auth bypass active — DO NOT use in production");
      // Dev bypass anchors to firm_id=1 (the seedDefaultFirm slug='default'
      // row created on boot). Production NEVER reaches this branch.
      req.user = { id: 0, email: "dev@mtos.local", name: "Dev Admin", role: "admin", firm_id: 1 };
      next();
      return;
    }
    auditDenial(req, "missing_credentials");
    sendUnauthorized(res, "Authentication required");
    return;
  }

  const token = authHeader.substring(7);

  // Task #52 — API key bearer path. The `mtos_` prefix lets us
  // disambiguate cheaply without paying the JWT verify cost. API key
  // requests bypass the 15-minute access token expiry but are scoped
  // per-resource: a key with `leads:read` cannot hit `/api/cases`.
  if (isApiKeyToken(token)) {
    const apiKey = await authenticateApiKey(token);
    if (!apiKey) {
      auditDenial(req, "invalid_api_key");
      sendUnauthorized(res, "Invalid or revoked API key");
      return;
    }
    if (!checkScope(apiKey.scopes, req.method, req.path)) {
      auditApiKeyRequest(
        apiKey.id,
        req.method,
        req.originalUrl,
        403,
        (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim() || req.socket.remoteAddress,
        req.headers["user-agent"],
      );
      auditDenial(req, "api_key_scope_denied", {
        extra: { api_key_id: apiKey.id, scopes: Array.from(apiKey.scopes) },
      });
      sendForbidden(res, "API key scope does not allow this route");
      return;
    }
    req.user = {
      id: apiKey.user_id,
      email: apiKey.user_email,
      name: `api-key:${apiKey.name}`,
      role: apiKey.user_role,
      firm_id: apiKey.firm_id,
    };
    // Tag the request so downstream handlers (and the response audit hook
    // below) can recognise an API-key call. Audit the outcome on response
    // finish so we capture the actual status code the route returned.
    (req as Request & { apiKey?: { id: number } }).apiKey = { id: apiKey.id };
    res.on("finish", () => {
      auditApiKeyRequest(
        apiKey.id,
        req.method,
        req.originalUrl,
        res.statusCode,
        (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim() || req.socket.remoteAddress,
        req.headers["user-agent"],
      );
    });
    next();
    return;
  }

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
    // Fail closed on DB outage during token-version check.
    logger.error("Token version check failed — denying request (fail-closed)");
    res.status(503).json({
      status: "error",
      code: "AUTH_UNAVAILABLE",
      message: "Authentication service temporarily unavailable",
    });
    return;
  }

  // firm_id MUST be present in the JWT for the single-firm shell contract.
  // Tokens issued before the firm_id claim was added (or hand-crafted
  // tokens missing it) get a hard fail-closed — there is no safe default.
  const firmId = (decoded as unknown as { firm_id?: number }).firm_id;
  if (typeof firmId !== "number" || !Number.isFinite(firmId) || firmId <= 0) {
    auditDenial(req, "missing_firm_claim", { decoded });
    sendUnauthorized(res, "Token missing firm context — please re-login");
    return;
  }

  req.user = {
    id: decoded.id,
    email: decoded.email,
    name: decoded.name,
    role: decoded.role,
    firm_id: firmId,
  };
  next();
}

export const authMiddleware = markAuthMiddleware(_authMiddleware);

// =============================================================================
// requireRole / requirePermission
// =============================================================================

// Pass the LOWEST role that is acceptable; higher roles per ROLE_HIERARCHY
// are also admitted.
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

// Any-of: passes iff the caller holds at least one of `permissions`.
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

interface AuditDenialOpts {
  required_roles?: readonly UserRole[];
  required_permissions?: readonly Permission[];
  // Used for paths where req.user isn't populated yet (e.g. token_revoked).
  decoded?: { id: number; email: string; role: UserRole };
  // Per-route ownership metadata (case_id, lead_id, owner_user_id, …).
  extra?: Record<string, unknown>;
}

// Canonical 401/403 audit writer. Every denial in this module funnels through
// here. Payload shape is documented in
// docs/audits/rbac-remediation-2026-04-26.md §5. Fire-and-forget — audit
// failures must never turn a 401 into a 500.
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
  email_verified_at: Date | null;
} & Record<string, unknown>;

/**
 * Optional verification fields for `createUser`. When supplied, the new
 * row is created in a "pending" state — `email_verified_at` is left NULL
 * and the verification token hash + expiry are stored. The caller is
 * responsible for emailing the corresponding plaintext token. When
 * omitted, the row is created already-verified (used by internal
 * paths such as ensureSystemUser).
 */
export interface CreateUserPendingVerification {
  tokenHash: string;
  expiresAt: Date;
}

export async function createUser(
  email: string,
  name: string,
  role: UserRole,
  passwordHash: string,
  firmId: number,
  pendingVerification?: CreateUserPendingVerification,
): Promise<AuthUser> {
  const verifiedAt = pendingVerification ? null : new Date();
  const tokenHash = pendingVerification?.tokenHash ?? null;
  const tokenExpires = pendingVerification?.expiresAt ?? null;
  const result = await db.execute(sql`
    INSERT INTO mtos_users (
      email, name, role, password_hash, firm_id,
      email_verified_at, email_verification_token_hash, email_verification_token_expires_at
    )
    VALUES (
      ${email}, ${name}, ${role}, ${passwordHash}, ${firmId},
      ${verifiedAt}, ${tokenHash}, ${tokenExpires}
    )
    RETURNING id, email, name, role, firm_id, token_version
  `);
  const rows = rowsOf<UserRow>(result);
  return rows[0] as AuthUser;
}

export async function getUserByEmail(email: string): Promise<UserCredentialsRow | null> {
  const result = await db.execute(sql`
    SELECT id, email, name, role, firm_id, password_hash, mfa_enabled, totp_secret,
           failed_login_attempts, locked_until, token_version, email_verified_at
    FROM mtos_users WHERE email = ${email} LIMIT 1
  `);
  const rows = rowsOf<UserCredentialsRow>(result);
  return rows[0] ?? null;
}

/**
 * Look up a user by the SHA-256 hash of their email-verification token,
 * but only return a row if the token is still within its expiry window
 * AND the account is still pending (email_verified_at IS NULL). A
 * second invocation of the same link, or a use after expiry, returns
 * null so the verify-email handler can respond with a generic
 * "invalid or expired" message instead of leaking which case applied.
 *
 * Comparison uses constant-time equality at the SQL layer (= on a
 * fixed-length hex string) and the column itself is indexed implicitly
 * via the row scan; for the volumes this single endpoint sees that is
 * adequate. Single-use is enforced by the verify-email handler clearing
 * both *_token_hash and *_token_expires_at on success.
 */
export async function getUserByVerificationToken(tokenHash: string): Promise<AuthUser | null> {
  const result = await db.execute(sql`
    SELECT id, email, name, role, firm_id, token_version
    FROM mtos_users
    WHERE email_verification_token_hash = ${tokenHash}
      AND email_verification_token_expires_at IS NOT NULL
      AND email_verification_token_expires_at > NOW()
      AND email_verified_at IS NULL
    LIMIT 1
  `);
  const rows = rowsOf<UserRow>(result);
  return rows[0] ? (rows[0] as AuthUser) : null;
}

/**
 * Mark a user as email-verified and clear the single-use token fields
 * atomically. Returns true when exactly one row transitioned from
 * pending → verified (the caller may then issue a JWT pair). Returns
 * false when no row matched the predicate (race: another request
 * already consumed this token, or the row was deleted).
 */
export async function markEmailVerified(userId: number, tokenHash: string): Promise<boolean> {
  const result = await db.execute(sql`
    UPDATE mtos_users
    SET email_verified_at = NOW(),
        email_verification_token_hash = NULL,
        email_verification_token_expires_at = NULL,
        updated_at = NOW()
    WHERE id = ${userId}
      AND email_verification_token_hash = ${tokenHash}
      AND email_verified_at IS NULL
    RETURNING id
  `);
  return rowsOf<{ id: number }>(result).length === 1;
}

export async function getUserById(id: number): Promise<AuthUser | null> {
  const result = await db.execute(sql`
    SELECT id, email, name, role, firm_id, token_version FROM mtos_users WHERE id = ${id} LIMIT 1
  `);
  const rows = rowsOf<UserRow>(result);
  return rows[0] ? (rows[0] as AuthUser) : null;
}

export async function listUsers(): Promise<AuthUser[]> {
  const result = await db.execute(sql`SELECT id, email, name, role, firm_id FROM mtos_users ORDER BY id`);
  return rowsOf<UserRow>(result) as AuthUser[];
}

/**
 * Row shape returned by the admin Users page (Task #58). Includes the
 * non-secret status fields admins need to triage accounts: MFA on/off,
 * verification state, and last successful login timestamp. Excludes
 * password_hash, totp_secret, and the verification token hash so this
 * row can be sent to the browser as-is.
 */
export interface AdminUserRow {
  id: number;
  email: string;
  name: string;
  role: UserRole;
  firm_id: number;
  mfa_enabled: boolean;
  email_verified_at: Date | null;
  last_login_at: Date | null;
  created_at: Date;
  // Index signature so this row type satisfies the rowsOf<T extends
  // Record<string, unknown>> constraint without losing field types.
  [key: string]: unknown;
}

/**
 * Fetch every user belonging to a single firm, ordered by created_at
 * desc so newly-registered viewers (the common reason an admin opens
 * this page) sort to the top. Scoped strictly by firm_id; a cross-firm
 * read would be a privilege escalation.
 */
export async function listUsersByFirm(firmId: number): Promise<AdminUserRow[]> {
  const result = await db.execute(sql`
    SELECT id, email, name, role, firm_id, mfa_enabled,
           email_verified_at, last_login_at, created_at
    FROM mtos_users
    WHERE firm_id = ${firmId}
    ORDER BY created_at DESC, id DESC
  `);
  return rowsOf<AdminUserRow>(result);
}

/**
 * Atomically rewrite a user's role AND bump token_version so any JWT
 * issued against the previous role is rejected on the next request
 * (see isTokenVersionRevoked + authMiddleware). Scoped by firm_id so
 * an admin in firm A can never touch a user in firm B even if they
 * guess the user id. Returns the updated row, or null when no row
 * matched (wrong firm, bad id, or DB-level race).
 */
export async function updateUserRoleAndBumpVersion(
  userId: number,
  firmId: number,
  newRole: UserRole,
): Promise<(AdminUserRow & { previous_role: UserRole }) | null> {
  // CTE captures the prior role in the same statement as the UPDATE so
  // the audit log can record an honest before/after pair without a
  // separate read-modify-write cycle (which would race with another
  // admin editing the same row, or fail-open on the DELETE-then-UPDATE
  // edge case). The firm_id predicate lives in `prev` so a wrong-firm
  // id resolves to "no prev row → no UPDATE → null return", which the
  // route then surfaces as a uniform 404.
  const result = await db.execute(sql`
    WITH prev AS (
      SELECT id, role AS old_role
      FROM mtos_users
      WHERE id = ${userId} AND firm_id = ${firmId}
    )
    UPDATE mtos_users
    SET role = ${newRole},
        token_version = token_version + 1,
        updated_at = NOW()
    FROM prev
    WHERE mtos_users.id = prev.id
    RETURNING mtos_users.id, mtos_users.email, mtos_users.name, mtos_users.role,
              mtos_users.firm_id, mtos_users.mfa_enabled,
              mtos_users.email_verified_at, mtos_users.last_login_at,
              mtos_users.created_at, prev.old_role AS previous_role
  `);
  const rows = rowsOf<AdminUserRow & { previous_role: UserRole }>(result);
  return rows[0] ?? null;
}

/**
 * Stamp last_login_at on a user row. Called by the auth /login route
 * after password (+ MFA) verification AND the email-verification gate
 * have both succeeded — never on failed attempts, so the column is a
 * faithful "last successful interactive login" signal admins can use to
 * triage dormant accounts.
 */
export async function stampLastLogin(userId: number): Promise<void> {
  await db.execute(sql`
    UPDATE mtos_users SET last_login_at = NOW(), updated_at = NOW()
    WHERE id = ${userId}
  `);
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
