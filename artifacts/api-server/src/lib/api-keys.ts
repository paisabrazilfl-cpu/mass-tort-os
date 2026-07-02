/**
 * Long-lived API key authentication for service accounts (Task #52).
 *
 * Token shape on the wire: `mtos_<base64url(48 bytes)>`. The `mtos_`
 * prefix lets the auth middleware cheaply distinguish API keys from
 * JWTs. Only the SHA-256 hash of the full token is stored; the
 * plaintext is shown once at creation time.
 *
 * Scopes are simple strings checked against `req.path`/`req.method`
 * (e.g. `leads:read`, `cases:write`). A key with `leads:read` cannot
 * hit anything outside `/api/leads*` GET/HEAD/OPTIONS.
 */
import crypto from "crypto";
import { and, eq, isNull, sql } from "drizzle-orm";
import { db, apiKeysTable, apiKeyAuditTable, usersTable, firmsTable } from "@workspace/db";
import { logger } from "./logger";

export const API_KEY_PREFIX = "mtos_";

export interface ApiKeyAuthResult {
  id: number;
  name: string;
  scopes: readonly string[];
  user_id: number;
  user_email: string;
  user_role: "super_admin" | "admin" | "attorney" | "paralegal" | "viewer";
  firm_id: number;
}

/** Generate a fresh plaintext token + its storage hash + a short prefix for display. */
export function mintApiKey(): { plaintext: string; hash: string; prefix: string } {
  const bytes = crypto.randomBytes(48).toString("base64url");
  const plaintext = `${API_KEY_PREFIX}${bytes}`;
  const hash = crypto.createHash("sha256").update(plaintext).digest("hex");
  // First 12 chars of the random body — enough to disambiguate keys in the
  // admin UI without revealing the whole secret.
  const prefix = `${API_KEY_PREFIX}${bytes.substring(0, 8)}…`;
  return { plaintext, hash, prefix };
}

export function hashApiKey(plaintext: string): string {
  return crypto.createHash("sha256").update(plaintext).digest("hex");
}

export function isApiKeyToken(token: string): boolean {
  return token.indexOf(API_KEY_PREFIX) === 0;
}

/**
 * Look up an API key by its plaintext value. Returns the resolved
 * service-account context (including the creator user's role + firm)
 * iff the key exists and is not revoked. Side effect: stamps
 * `last_used_at` on the row.
 */
export async function authenticateApiKey(plaintext: string): Promise<ApiKeyAuthResult | null> {
  const hash = hashApiKey(plaintext);
  const [row] = await db
    .select({
      id: apiKeysTable.id,
      name: apiKeysTable.name,
      scopes: apiKeysTable.scopes,
      firm_id: apiKeysTable.firm_id,
      created_by_user_id: apiKeysTable.created_by_user_id,
      revoked_at: apiKeysTable.revoked_at,
    })
    .from(apiKeysTable)
    .where(and(eq(apiKeysTable.key_hash, hash), isNull(apiKeysTable.revoked_at)));
  if (!row) return null;

  const [user] = await db
    .select({ id: usersTable.id, email: usersTable.email, role: usersTable.role })
    .from(usersTable)
    .where(eq(usersTable.id, row.created_by_user_id));
  if (!user) {
    logger.warn({ api_key_id: row.id }, "api-key authenticated against deleted user — rejecting");
    return null;
  }

  // Stamp last_used_at — fire-and-forget so a slow write doesn't block the
  // authenticated request.
  db.update(apiKeysTable)
    .set({ last_used_at: new Date() })
    .where(eq(apiKeysTable.id, row.id))
    .catch(() => {});

  return {
    id: row.id,
    name: row.name,
    scopes: row.scopes ?? [],
    user_id: user.id,
    user_email: user.email,
    user_role: user.role as ApiKeyAuthResult["user_role"],
    firm_id: row.firm_id,
  };
}

/**
 * Per-route scope check. Scopes are matched against the route's first
 * path segment (e.g. `leads`, `cases`) plus an action — `read` for
 * GET/HEAD/OPTIONS, `write` for everything else. A wildcard scope `*`
 * grants everything (use sparingly).
 *
 * Examples:
 *   - `leads:read` — passes for GET /api/leads*
 *   - `leads:write` — passes for POST/PATCH/DELETE /api/leads*
 *   - `*`           — passes for any route
 *
 * `path` should be the route path *without* the `/api` mount prefix
 * (callers from authMiddleware must pass `req.path`, which Express
 * already normalizes to the path within the mounted router).
 */
export function checkScope(scopes: readonly string[], method: string, path: string): boolean {
  let hasWildcard = false;
  for (let i = 0; i < scopes.length; i++) {
    if (scopes[i] === "*") { hasWildcard = true; break; }
  }
  if (hasWildcard) return true;

  const m = method.toUpperCase();
  const action = (m === "GET" || m === "HEAD" || m === "OPTIONS") ? "read" : "write";

  // Strip leading slash, take first segment.
  const p = path.replace(/^\/+/, "");
  const firstSlash = p.indexOf("/");
  const segment = firstSlash === -1 ? p : p.substring(0, firstSlash);

  if (!segment) return false;

  // A `:write` scope implies `:read` on the same resource (a key that
  // can mutate can also observe).
  const writeScope = `${segment}:write`;
  const actionScope = `${segment}:${action}`;

  for (let i = 0; i < scopes.length; i++) {
    if (action === "read" && scopes[i] === writeScope) return true;
    if (scopes[i] === actionScope) return true;
  }

  return false;
}

/** Audit a single API-key request. Fire-and-forget — never throws. */
export function auditApiKeyRequest(
  apiKeyId: number,
  method: string,
  route: string,
  statusCode: number,
  ipAddress: string | undefined,
  userAgent: string | undefined,
): void {
  db.insert(apiKeyAuditTable)
    .values({
      api_key_id: apiKeyId,
      route,
      method,
      status_code: statusCode,
      ip_address: ipAddress ?? null,
      user_agent: userAgent ?? null,
    })
    .catch((err) => {
      logger.warn({ err, api_key_id: apiKeyId }, "api-key audit insert failed");
    });
}

export const KNOWN_SCOPES = [
  "*",
  "leads:read", "leads:write",
  "cases:read", "cases:write",
  "documents:read", "documents:write",
  "ocr:read", "ocr:write",
  "paralegals:read", "paralegals:write",
  "npi:read",
  "review-queue:read", "review-queue:write",
  "automations:read", "automations:write",
  "dashboard:read",
  "analytics:read",
] as const;

export type Scope = typeof KNOWN_SCOPES[number];

/** Insert a new key row. Returns the plaintext (caller must surface once). */
export async function createApiKey(input: {
  name: string;
  scopes: string[];
  firm_id: number;
  created_by_user_id: number;
}): Promise<{ id: number; plaintext: string; prefix: string }> {
  const minted = mintApiKey();
  const [row] = await db
    .insert(apiKeysTable)
    .values({
      name: input.name,
      key_hash: minted.hash,
      key_prefix: minted.prefix,
      scopes: input.scopes,
      firm_id: input.firm_id,
      created_by_user_id: input.created_by_user_id,
    })
    .returning({ id: apiKeysTable.id });
  return { id: row.id, plaintext: minted.plaintext, prefix: minted.prefix };
}

/**
 * Revoke a key. Scoped by firmId to prevent cross-tenant IDOR — an admin
 * for Firm A must never be able to revoke a key belonging to Firm B by
 * guessing/enumerating its numeric id. Returns false (caller should 404)
 * if the id does not exist OR belongs to a different firm OR is already
 * revoked.
 */
export async function revokeApiKey(id: number, firmId: number): Promise<boolean> {
  const result = await db
    .update(apiKeysTable)
    .set({ revoked_at: new Date() })
    .where(
      and(
        eq(apiKeysTable.id, id),
        eq(apiKeysTable.firm_id, firmId),
        isNull(apiKeysTable.revoked_at),
      ),
    )
    .returning({ id: apiKeysTable.id });
  return result.length > 0;
}

/** Returns true iff the key exists AND belongs to the given firm. */
export async function apiKeyBelongsToFirm(id: number, firmId: number): Promise<boolean> {
  const [row] = await db
    .select({ id: apiKeysTable.id })
    .from(apiKeysTable)
    .where(and(eq(apiKeysTable.id, id), eq(apiKeysTable.firm_id, firmId)))
    .limit(1);
  return Boolean(row);
}

export async function listApiKeys(firmId: number): Promise<Array<{
  id: number;
  name: string;
  prefix: string;
  scopes: readonly string[];
  created_at: Date | null;
  last_used_at: Date | null;
  revoked_at: Date | null;
  created_by_user_id: number;
}>> {
  const rows = await db
    .select({
      id: apiKeysTable.id,
      name: apiKeysTable.name,
      prefix: apiKeysTable.key_prefix,
      scopes: apiKeysTable.scopes,
      created_at: apiKeysTable.created_at,
      last_used_at: apiKeysTable.last_used_at,
      revoked_at: apiKeysTable.revoked_at,
      created_by_user_id: apiKeysTable.created_by_user_id,
    })
    .from(apiKeysTable)
    .where(eq(apiKeysTable.firm_id, firmId))
    .orderBy(sql`${apiKeysTable.created_at} DESC`);
  return rows.map((r) => ({ ...r, scopes: r.scopes ?? [] }));
}
