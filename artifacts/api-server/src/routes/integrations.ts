import { Router, Response } from "express";
import { db, integrationsTable } from "@workspace/db";
import { eq, desc, and } from "drizzle-orm";
import { Permission, requirePermission } from "../lib/rbac";
import { auditLog } from "../lib/audit";
import { PRESET_INTEGRATIONS } from "../lib/integration-presets";
import { getWiring, isWired, consumesVaultCredentials } from "../lib/integration-wiring";
import { encrypt, decrypt } from "../lib/encryption";
import { logger } from "../lib/logger";
import { pingLeadWebhook } from "../lib/lead-webhook-dispatcher";
import { badRequest } from "../lib/http-errors";
import { getSyncHandler } from "../lib/integration-sync";
import crypto from "crypto";

const router = Router();

// Validate :id route param. Returns the parsed positive integer, or null after
// emitting a 400 response. Caller must `return` on null.
function parseIntegrationId(res: Response, raw: unknown): number | null {
  const id = Number(Array.isArray(raw) ? raw[0] : raw);
  if (!Number.isInteger(id) || id <= 0) {
    badRequest(res, "Integration id must be a positive integer");
    return null;
  }
  return id;
}

// Credential field names that we treat as secrets (encrypted at rest).
// `api_url` and `webhook_url` are NOT secrets — they are stored plaintext.
// `public_key` IS included: while Vapi's public key is browser-safe by design,
// it is still a user credential that should be encrypted at rest in the vault.
const SECRET_FIELDS = ["api_key", "public_key", "client_id", "client_secret", "account_sid", "access_id", "access_password", "fax_number", "sender_email", "from_email", "from_name"] as const;
type SecretField = (typeof SECRET_FIELDS)[number];

// AAD scope is the integration row id, not the provider, so two rows that
// share a provider cannot accidentally cross-decrypt each other's secrets.
function buildEncryptedCredentials(rowId: number, body: Record<string, any>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of SECRET_FIELDS) {
    if (body[f]) {
      out[f] = encrypt(String(body[f]), `integration:${f}`, String(rowId));
    }
  }
  return out;
}

function maskCredentials(creds: Record<string, any> | undefined | null): Record<string, string> {
  if (!creds || typeof creds !== "object") return {};
  const out: Record<string, string> = {};
  for (const k of Object.keys(creds)) out[k] = "****";
  return out;
}

export interface DecryptedCredentials {
  api_key?: string; public_key?: string; client_id?: string; client_secret?: string; account_sid?: string;
  access_id?: string; access_password?: string; fax_number?: string; sender_email?: string;
  from_email?: string; from_name?: string;
  api_url?: string | null; webhook_url?: string | null; config?: any;
  _decryption_errors?: SecretField[];
}

function decryptRowCredentials(row: any): DecryptedCredentials {
  const stored = ((row.config as any)?.credentials || {}) as Record<string, string>;
  const out: DecryptedCredentials = { api_url: row.api_url, webhook_url: row.webhook_url };
  const errors: SecretField[] = [];
  for (const f of SECRET_FIELDS) {
    if (stored[f]) {
      try {
        const plain = decrypt(stored[f], `integration:${f}`, String(row.id));
        // decrypt() returns the literal string "[DECRYPTION_ERROR]" on AAD/key mismatch
        if (plain === "[DECRYPTION_ERROR]") {
          errors.push(f);
          logger.error({ provider: row.provider, id: row.id, field: f }, "Integration credential decryption returned error sentinel");
        } else {
          out[f] = plain;
        }
      } catch (err) {
        errors.push(f);
        logger.error({ err, provider: row.provider, id: row.id, field: f }, "Failed to decrypt integration credential");
      }
    }
  }
  if (errors.length) out._decryption_errors = errors;
  out.config = (row.config as any)?.userConfig || {};
  return out;
}

/**
 * Look up credentials by integration id. Use this when a workflow knows
 * the specific integration row it wants to call (preferred).
 */
export async function getIntegrationCredentialsById(id: number): Promise<DecryptedCredentials | null> {
  const [row] = await db.select().from(integrationsTable).where(eq(integrationsTable.id, id));
  if (!row || row.status !== "active") return null;
  return decryptRowCredentials(row);
}

/**
 * Convenience helper for cases where only the provider key is known.
 * Returns the most recent active integration for that provider; logs a warning
 * if multiple are present so the caller can switch to id-based lookup.
 */
export async function getIntegrationCredentials(provider: string, firmId?: number): Promise<DecryptedCredentials | null> {
  const conditions = firmId !== undefined
    ? and(eq(integrationsTable.provider, provider), eq(integrationsTable.firm_id, firmId))
    : eq(integrationsTable.provider, provider);
  const rows = await db
    .select()
    .from(integrationsTable)
    .where(conditions)
    .orderBy(desc(integrationsTable.created_at));
  const active = rows.filter(r => r.status === "active");
  if (active.length === 0) return null;
  if (active.length > 1) {
    logger.warn({ provider, count: active.length }, "Multiple active integrations share this provider — using most recent. Prefer getIntegrationCredentialsById().");
  }
  return decryptRowCredentials(active[0]);
}

/**
 * Resolve a firm's OUTBOUND n8n MCP connection (CRM → n8n workflow execution).
 *
 * Per-firm credential isolation: the MCP server URL lives in the n8n
 * integration's plaintext `api_url` column and the access token in its
 * encrypted `api_key`. Returns null when the firm has no active n8n
 * integration or the connection is incomplete. Callers MUST treat null as
 * "this firm is not connected" and never fall back to the owner's global env
 * instance — that fallback is the cross-tenant leak this isolation prevents.
 */
export async function getN8nConnForFirm(firmId: number): Promise<{ url: string; token: string } | null> {
  const rows = await db
    .select()
    .from(integrationsTable)
    .where(and(eq(integrationsTable.provider, "n8n"), eq(integrationsTable.firm_id, firmId)))
    .orderBy(desc(integrationsTable.created_at));
  const row = rows.find((r) => r.status === "active");
  if (!row) return null;
  const url = (row.api_url || "").trim();
  if (!url) return null;
  const creds = await decryptRowCredentials(row);
  if (creds._decryption_errors && creds._decryption_errors.length > 0) return null;
  const token = typeof creds.api_key === "string" ? creds.api_key.trim() : "";
  if (!token) return null;
  return { url, token };
}

router.get("/categories", requirePermission(Permission.INTEGRATIONS_MANAGE), (_req, res) => {
  const cats = Array.from(new Set(PRESET_INTEGRATIONS.map(p => p.category))).sort();
  res.json(cats);
});

router.get("/presets", requirePermission(Permission.INTEGRATIONS_MANAGE), (_req, res) => {
  // Annotate each preset with its current wiring status so the admin UI can
  // honestly distinguish "this provider has live adapter code" from "saving
  // credentials here has no effect on workflows yet".
  res.json(
    PRESET_INTEGRATIONS.map((p) => {
      const w = getWiring(p.provider);
      return { ...p, wired: w.status, wiring_note: w.note };
    }),
  );
});

function maskRow(row: any) {
  const credentials = (row.config as any)?.credentials;
  return {
    ...row,
    api_key_hash: row.api_key_hash ? "****" : null,
    config: { ...(row.config || {}), credentials: maskCredentials(credentials) },
  };
}

router.get("/", requirePermission(Permission.INTEGRATIONS_MANAGE), async (_req, res) => {
  const rows = await db.select().from(integrationsTable).orderBy(desc(integrationsTable.created_at));
  res.json(rows.map(maskRow));
});

router.get("/:id", requirePermission(Permission.INTEGRATIONS_MANAGE), async (req, res) => {
  const id = parseIntegrationId(res, req.params.id); if (id === null) return;
  const [row] = await db.select().from(integrationsTable).where(eq(integrationsTable.id, id));
  if (!row) { res.status(404).json({ error: "Integration not found" }); return; }
  res.json(maskRow(row));
});

router.post("/", requirePermission(Permission.INTEGRATIONS_MANAGE), async (req, res) => {
  const { name, type, provider, api_url, webhook_url, config, sync_direction, field_mapping, api_key } = req.body;
  if (!name || !type || !provider) {
    res.status(400).json({ error: "Name, type, and provider are required" }); return;
  }

  // Keep a short non-reversible reference for audit/UI display continuity.
  const apiKeyRef = api_key ? crypto.createHash("sha256").update(String(api_key)).digest("hex").slice(0, 16) : null;

  // Two-step insert: we need the row id before we can encrypt creds with id-scoped AAD.
  const [created] = await db.insert(integrationsTable).values({
    name,
    type,
    provider,
    status: "active",
    api_url: api_url || null,
    api_key_hash: apiKeyRef,
    webhook_url: webhook_url || null,
    config: { ...(config && typeof config === "object" ? { userConfig: config } : {}), credentials: {} },
    sync_direction: sync_direction || "bidirectional",
    field_mapping: field_mapping || null,
  }).returning();

  const credentials = buildEncryptedCredentials(created.id, req.body);
  const finalConfig = {
    ...(config && typeof config === "object" ? { userConfig: config } : {}),
    credentials,
  };
  const [row] = await db.update(integrationsTable)
    .set({ config: finalConfig })
    .where(eq(integrationsTable.id, created.id))
    .returning();

  await auditLog("integration", String(req.user?.id || 0), "integration_created", {
    provider, name, type, credential_keys: Object.keys(credentials),
  });
  res.status(201).json(maskRow(row));
});

router.patch("/:id", requirePermission(Permission.INTEGRATIONS_MANAGE), async (req, res) => {
  const id = parseIntegrationId(res, req.params.id); if (id === null) return;
  const [existing] = await db.select().from(integrationsTable).where(eq(integrationsTable.id, id));
  if (!existing) { res.status(404).json({ error: "Not found" }); return; }

  const { name, status, api_url, webhook_url, config, sync_direction, field_mapping, api_key } = req.body;
  const updates: Record<string, any> = { updated_at: new Date() };

  if (name !== undefined) updates.name = name;
  if (status !== undefined) updates.status = status;
  if (api_url !== undefined) updates.api_url = api_url;
  if (webhook_url !== undefined) updates.webhook_url = webhook_url;
  if (sync_direction !== undefined) updates.sync_direction = sync_direction;
  if (field_mapping !== undefined) updates.field_mapping = field_mapping;
  if (api_key) updates.api_key_hash = crypto.createHash("sha256").update(String(api_key)).digest("hex").slice(0, 16);

  // Merge any newly supplied secret fields into existing encrypted set (id-scoped AAD)
  const newCreds = buildEncryptedCredentials(existing.id, req.body);
  if (Object.keys(newCreds).length > 0 || config !== undefined) {
    const existingConfig = (existing.config as any) || {};
    const existingCreds = existingConfig.credentials || {};
    updates.config = {
      ...existingConfig,
      ...(config !== undefined ? { userConfig: config } : {}),
      credentials: { ...existingCreds, ...newCreds },
    };
  }

  const [updated] = await db.update(integrationsTable).set(updates).where(eq(integrationsTable.id, id)).returning();
  await auditLog("integration", String(req.user?.id || 0), "integration_updated", { id, changes: Object.keys(updates) });
  res.json(maskRow(updated));
});

router.delete("/:id", requirePermission(Permission.INTEGRATIONS_MANAGE), async (req, res) => {
  const id = parseIntegrationId(res, req.params.id); if (id === null) return;
  const [deleted] = await db.delete(integrationsTable).where(eq(integrationsTable.id, id)).returning();
  if (!deleted) { res.status(404).json({ error: "Not found" }); return; }
  await auditLog("integration", String(req.user?.id || 0), "integration_deleted", { id, provider: deleted.provider });
  res.json({ success: true });
});

router.post("/:id/test", requirePermission(Permission.INTEGRATIONS_MANAGE), async (req, res) => {
  const id = parseIntegrationId(res, req.params.id); if (id === null) return;
  const [row] = await db.select().from(integrationsTable).where(eq(integrationsTable.id, id));
  if (!row) { res.status(404).json({ error: "Not found" }); return; }

  // Verify credential decryption works end-to-end. Only secret fields count —
  // api_url / webhook_url are plaintext config and don't prove decryption works.
  const preset = PRESET_INTEGRATIONS.find(p => p.provider === row.provider);
  const expectedSecretFields = (preset?.fields || []).filter(
    (f): f is SecretField => (SECRET_FIELDS as readonly string[]).includes(f)
  );
  const storedCreds = ((row.config as any)?.credentials || {}) as Record<string, string>;
  const storedSecretKeys = Object.keys(storedCreds).filter(k => (SECRET_FIELDS as readonly string[]).includes(k));

  let credentialCheck: "ok" | "no_credentials_stored" | "decryption_failed" | "missing_required_secret" = "ok";
  let decryptionErrors: SecretField[] = [];

  if (storedSecretKeys.length === 0) {
    credentialCheck = "no_credentials_stored";
  } else {
    const creds = await getIntegrationCredentialsById(row.id);
    if (!creds) {
      credentialCheck = "no_credentials_stored";
    } else if (creds._decryption_errors && creds._decryption_errors.length > 0) {
      credentialCheck = "decryption_failed";
      decryptionErrors = creds._decryption_errors;
    } else {
      // Confirm every preset-declared secret field is present and non-empty after decryption
      const missing = expectedSecretFields.filter(f => !creds[f] || String(creds[f]).length === 0);
      if (missing.length > 0) {
        credentialCheck = "missing_required_secret";
        decryptionErrors = missing as SecretField[];
      }
    }
  }

  // For type=automation integrations (n8n / Zapier / Make), we go further
  // than credential decryption and actually POST a sample lead.created
  // payload to the configured webhook_url. This is the only way to honestly
  // confirm end-to-end wiring — without it the operator has no way to know
  // whether their n8n flow will actually receive our events.
  let livePing: {
    attempted: boolean;
    response_status: number | null;
    latency_ms: number | null;
    signed: boolean;
    delivery_id: string | null;
    error: string | null;
    reason: string | null;
  } = {
    attempted: false,
    response_status: null,
    latency_ms: null,
    signed: false,
    delivery_id: null,
    error: null,
    reason: null,
  };
  if (row.type === "automation" && row.webhook_url && row.status === "active") {
    const ping = await pingLeadWebhook(row.id);
    livePing = {
      attempted: ping.attempted,
      response_status: ping.response_status ?? null,
      latency_ms: ping.latency_ms ?? null,
      signed: !!ping.signed,
      delivery_id: ping.delivery_id ?? null,
      error: ping.error ?? null,
      reason: ping.reason ?? null,
    };
  }

  // For non-automation providers we still don't fake a round-trip — there's
  // no per-provider echo handler, and reporting a fake latency would mislead
  // the operator. Credential decryption is what we can verify; that alone
  // catches encryption-key drift, AAD mismatches, and partial saves.
  const credsOk = credentialCheck === "ok";
  const pingOk =
    !livePing.attempted ||
    (livePing.response_status !== null && livePing.response_status >= 200 && livePing.response_status < 300);

  // The most important signal an operator needs before migration: does this
  // build actually have adapter code that will USE these credentials? If
  // not, saving credentials and clicking Test is theatre. We refuse to
  // claim "success: true" for vault-only providers no matter how cleanly
  // their credentials decrypt — workflows will never call them.
  //
  // For "live_no_vault" providers (today: Anthropic via Replit AI SDK)
  // the underlying feature works regardless of what's in the vault, so we
  // do report success: true — but the message and explicit `vault_consumed`
  // field tell the operator that the saved credentials themselves are not
  // what makes the feature work.
  //
  // Contract for non-UI consumers:
  //   - Use `credential_check === "ok"` for credential-vault viability.
  //   - Use `adapter_wired` for "is there code that calls this provider".
  //   - Use `vault_consumed` for "do those credentials actually get used".
  //   - `success` is the rolled-up answer to "would clicking this row do
  //     something useful right now"; do not rely on it for credential
  //     viability alone.
  const wiring = getWiring(row.provider);
  const adapterWired = isWired(row.provider) || row.type === "automation";
  const vaultConsumed = consumesVaultCredentials(row.provider) || row.type === "automation";

  // For live_no_vault providers, credential check is irrelevant — the
  // feature works without any saved vault credentials.
  const ok = vaultConsumed
    ? credsOk && pingOk && adapterWired
    : adapterWired;

  let message: string;
  if (livePing.attempted) {
    if (pingOk) {
      message = `Credentials decrypt successfully and the webhook at ${row.webhook_url} responded ${livePing.response_status} in ${livePing.latency_ms}ms${livePing.signed ? " (signed with HMAC-SHA256)" : " (no api_key on file — sent unsigned)"}.`;
    } else if (livePing.error) {
      message = `Webhook delivery failed: ${livePing.error}. Verify the URL is reachable and accepts POST.`;
    } else {
      message = `Webhook responded ${livePing.response_status} (expected 2xx). Check that your n8n / Zapier / Make endpoint accepts POST and returns success.`;
    }
  } else if (wiring.status === "live_no_vault") {
    message = `${row.provider} powers AI features in this build via the Replit AI Integrations SDK, which manages its own auth via environment variables. Credentials saved here are NOT consumed — there is nothing to test for the vault entry. The feature works regardless of what is saved here.`;
  } else if (credsOk && !adapterWired) {
    message = `Credentials for ${row.provider} decrypt successfully, but no live adapter for this provider is wired in this build. Saving credentials here has no effect on workflows yet — an adapter must be added under lib/${row.type || "providers"}/ before this integration will fire.`;
  } else if (credsOk) {
    message = `Credentials for ${row.provider} are present and decrypt successfully. Live API ping for this provider is not yet implemented, but workflow handlers will use them.`;
  } else if (credentialCheck === "no_credentials_stored") {
    message = "No secret credentials are stored for this integration. Reconnect and supply the required keys.";
  } else if (credentialCheck === "decryption_failed") {
    message = `Decryption failed for: ${decryptionErrors.join(", ")}. The encryption key may have changed; reconnect with fresh credentials.`;
  } else {
    message = `Missing required secret(s): ${decryptionErrors.join(", ")}. Reconnect and supply all preset-declared fields.`;
  }

  res.json({
    success: ok,
    credential_check: credentialCheck,
    adapter_wired: adapterWired,
    vault_consumed: vaultConsumed,
    wiring_status: wiring.status,
    wiring_note: wiring.note,
    live_api_ping: livePing.attempted,
    response_status: livePing.response_status,
    latency_ms: livePing.latency_ms,
    signed: livePing.signed,
    delivery_id: livePing.delivery_id,
    ping_error: livePing.error,
    ping_skip_reason: livePing.reason,
    message,
    timestamp: new Date().toISOString(),
  });
});

router.post("/:id/sync", requirePermission(Permission.INTEGRATIONS_MANAGE), async (req, res) => {
  const id = parseIntegrationId(res, req.params.id); if (id === null) return;
  const [integration] = await db.select().from(integrationsTable).where(eq(integrationsTable.id, id));
  if (!integration) { res.status(404).json({ error: "Not found" }); return; }

  const handler = getSyncHandler(integration.provider);
  if (!handler) {
    await auditLog("integration", String(req.user?.id || 0), "integration_sync_requested", {
      id,
      provider: integration.provider,
      handler_implemented: false,
    });
    res.status(501).json({
      success: false,
      implemented: false,
      records_synced: 0,
      direction: integration.sync_direction,
      message: `Sync handler for ${integration.provider} is not yet implemented. The credential vault is wired up — once a provider-specific sync worker is added, this button will run it.`,
      timestamp: new Date().toISOString(),
    });
    return;
  }

  const outcome = await handler(integration);
  await auditLog("integration", String(req.user?.id || 0), "integration_sync_requested", {
    id,
    provider: integration.provider,
    handler_implemented: true,
    ok: outcome.ok,
    records_synced: outcome.records_synced,
    direction: outcome.direction,
    details: outcome.details,
    error: outcome.error ?? null,
  });

  res.json({
    success: outcome.ok,
    implemented: true,
    records_synced: outcome.records_synced,
    direction: outcome.direction,
    details: outcome.details ?? null,
    error: outcome.error ?? null,
    message: outcome.ok
      ? `Sync completed for ${integration.provider}.`
      : `Sync for ${integration.provider} finished with errors.`,
    timestamp: new Date().toISOString(),
  });
});

export default router;
