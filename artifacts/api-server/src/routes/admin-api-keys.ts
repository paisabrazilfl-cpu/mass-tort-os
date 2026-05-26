/**
 * Admin-only CRUD for service-account API keys (Task #52).
 *
 * Mounted at /api/admin/api-keys. Plaintext token is returned ONCE on
 * creation and never again — operators copy it into n8n's HTTP credential
 * immediately. Every other surface only ever exposes the truncated
 * `prefix` for display.
 *
 * Audit (per-key request log) is read-only via GET /:id/audit so admins
 * can answer "where is this key being used?" without raw DB access.
 */
import { Router } from "express";
import { z } from "zod";
import { and, desc, eq } from "drizzle-orm";
import { db, apiKeyAuditTable } from "@workspace/db";
import { Permission, requirePermission } from "../lib/rbac";
import {
  createApiKey,
  listApiKeys,
  revokeApiKey,
  apiKeyBelongsToFirm,
  KNOWN_SCOPES,
} from "../lib/api-keys";
import { auditLog } from "../lib/audit";
import { badRequest, notFound } from "../lib/http-errors";

const router = Router();

const KnownScopeSet = new Set<string>(KNOWN_SCOPES);
const ScopeSchema = z.string().refine((s) => KnownScopeSet.has(s), {
  message: `Scope must be one of: ${KNOWN_SCOPES.join(", ")}`,
});

const CreateBody = z.object({
  name: z.string().trim().min(1).max(100),
  scopes: z.array(ScopeSchema).min(1).max(20),
  description: z.string().trim().max(500).nullish(),
  // Number of days until the key auto-expires. Null = never. Clamped 1..3650.
  expires_in_days: z.number().int().min(1).max(3650).nullish(),
});

const IdParam = z.object({ id: z.coerce.number().int().positive() });

router.get("/", requirePermission(Permission.API_KEYS_MANAGE), async (req, res) => {
  const keys = await listApiKeys(req.user!.firm_id);
  res.json({ keys });
});

router.post("/", requirePermission(Permission.API_KEYS_MANAGE), async (req, res) => {
  const parsed = CreateBody.safeParse(req.body);
  if (!parsed.success) { badRequest(res, "Invalid request body", parsed.error.issues); return; }
  const user = req.user!;
  const created = await createApiKey({
    name: parsed.data.name,
    scopes: parsed.data.scopes,
    firm_id: user.firm_id,
    created_by_user_id: user.id,
  });
  await auditLog("api_key", String(created.id), "created", {
    name: parsed.data.name,
    scopes: parsed.data.scopes,
    firm_id: user.firm_id,
    created_by: user.id,
  });
  res.status(201).json({
    id: created.id,
    name: parsed.data.name,
    scopes: parsed.data.scopes,
    prefix: created.prefix,
    // Plaintext is returned ONCE here — never readable again.
    plaintext: created.plaintext,
    warning: "Store this token now. It will not be shown again.",
  });
});

router.delete("/:id", requirePermission(Permission.API_KEYS_MANAGE), async (req, res) => {
  const parsed = IdParam.safeParse(req.params);
  if (!parsed.success) { badRequest(res, "Invalid id", parsed.error.issues); return; }
  // Scope by firm_id to defend against cross-tenant IDOR. revokeApiKey
  // returns false if the row does not exist, belongs to another firm,
  // or is already revoked — surface as 404 in all three cases so we
  // don't leak existence of out-of-firm key ids.
  const ok = await revokeApiKey(parsed.data.id, req.user!.firm_id);
  if (!ok) { notFound(res); return; }
  await auditLog("api_key", String(parsed.data.id), "revoked", {
    revoked_by: req.user!.id,
    firm_id: req.user!.firm_id,
  });
  res.status(204).send();
});

router.get("/:id/audit", requirePermission(Permission.API_KEYS_MANAGE), async (req, res) => {
  const parsed = IdParam.safeParse(req.params);
  if (!parsed.success) { badRequest(res, "Invalid id", parsed.error.issues); return; }
  // Confirm the key belongs to this firm before returning its access log.
  // 404 (not 403) so we don't reveal which numeric ids exist in other firms.
  const owned = await apiKeyBelongsToFirm(parsed.data.id, req.user!.firm_id);
  if (!owned) { notFound(res); return; }
  const rows = await db
    .select()
    .from(apiKeyAuditTable)
    .where(eq(apiKeyAuditTable.api_key_id, parsed.data.id))
    .orderBy(desc(apiKeyAuditTable.occurred_at))
    .limit(200);
  res.json({ entries: rows });
});

router.get("/_meta/scopes", requirePermission(Permission.API_KEYS_MANAGE), (_req, res) => {
  res.json({ scopes: KNOWN_SCOPES });
});

export default router;
