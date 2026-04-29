import crypto from "crypto";
import { and, eq } from "drizzle-orm";
import { db, integrationsTable } from "@workspace/db";
import { decrypt } from "./encryption";
import { logger } from "./logger";
import { auditLog } from "./audit";

const DISPATCH_TIMEOUT_MS = 5000;
const SIGNING_FIELD = "api_key";

export interface LeadWebhookLeadRef {
  id: number;
  name: string | null;
  first_name: string | null;
  last_name: string | null;
  email: string | null;
  state: string | null;
  tort_type: string | null;
  status: string | null;
  source: string | null;
  created_at: string;
}

export interface LeadWebhookPayload {
  event: "lead.created";
  delivery_id: string;
  timestamp: string;
  source: string;
  lead: LeadWebhookLeadRef;
}

export interface DispatchInput {
  source: string;
  lead: LeadWebhookLeadRef;
}

export interface PingResult {
  attempted: boolean;
  reason?: "no_webhook_url" | "not_active" | "not_found" | "wrong_type";
  response_status?: number;
  latency_ms?: number;
  signed?: boolean;
  delivery_id?: string;
  error?: string;
}

function decryptIntegrationApiKey(
  row: typeof integrationsTable.$inferSelect,
): string | null {
  const stored = ((row.config as { credentials?: Record<string, string> } | null)?.credentials || {}) as Record<string, string>;
  const cipher = stored[SIGNING_FIELD];
  if (!cipher) return null;
  try {
    const plain = decrypt(cipher, `integration:${SIGNING_FIELD}`, String(row.id));
    if (plain === "[DECRYPTION_ERROR]") return null;
    return plain;
  } catch {
    return null;
  }
}

function signPayload(secret: string, body: string): string {
  return "sha256=" + crypto.createHmac("sha256", secret).update(body).digest("hex");
}

async function postWithTimeout(
  url: string,
  body: string,
  headers: Record<string, string>,
): Promise<{ status: number; latencyMs: number; error?: string }> {
  const start = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DISPATCH_TIMEOUT_MS);
  try {
    const r = await fetch(url, {
      method: "POST",
      body,
      headers,
      signal: controller.signal,
    });
    return { status: r.status, latencyMs: Date.now() - start };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { status: 0, latencyMs: Date.now() - start, error: message };
  } finally {
    clearTimeout(timer);
  }
}

function buildHeaders(payload: LeadWebhookPayload, secret: string | null, isTest: boolean): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "User-Agent": "MTOS-CRM/1.0",
    "X-MTOS-Event": payload.event,
    "X-MTOS-Delivery": payload.delivery_id,
  };
  if (isTest) headers["X-MTOS-Test"] = "true";
  if (secret) headers["X-MTOS-Signature"] = signPayload(secret, JSON.stringify(payload));
  return headers;
}

/**
 * Fire `lead.created` to every active integration of type `automation`
 * (n8n, Zapier, Make) that has a `webhook_url` configured. Non-blocking:
 * runs on the next tick and never throws back to the caller — a slow or
 * failing third-party endpoint must NEVER cause our lead-creation HTTP
 * response to fail.
 *
 * Each delivery is audit-logged (`entity_type=integration`,
 * `action=webhook_dispatched`) with the response status, latency, and any
 * error so the operator can see at a glance which deliveries succeeded.
 *
 * If the integration has an `api_key` saved we sign the payload with
 * HMAC-SHA256 and send the digest in `X-MTOS-Signature: sha256=<hex>`.
 * If no api_key is present we send the payload unsigned and record
 * `signed: false` in the audit row — we do not pretend we signed it.
 */
export function dispatchLeadCreated(input: DispatchInput): void {
  setImmediate(async () => {
    try {
      const rows = await db
        .select()
        .from(integrationsTable)
        .where(
          and(
            eq(integrationsTable.type, "automation"),
            eq(integrationsTable.status, "active"),
          ),
        );

      const targets = rows.filter(
        (r): r is typeof integrationsTable.$inferSelect & { webhook_url: string } =>
          typeof r.webhook_url === "string" && r.webhook_url.length > 0,
      );
      if (targets.length === 0) return;

      const payload: LeadWebhookPayload = {
        event: "lead.created",
        delivery_id: crypto.randomUUID(),
        timestamp: new Date().toISOString(),
        source: input.source,
        lead: input.lead,
      };
      const body = JSON.stringify(payload);

      for (const integ of targets) {
        const secret = decryptIntegrationApiKey(integ);
        const headers = buildHeaders(payload, secret, false);
        const result = await postWithTimeout(integ.webhook_url, body, headers);
        const ok = result.status >= 200 && result.status < 300;

        await auditLog("integration", "system", "webhook_dispatched", {
          integration_id: integ.id,
          provider: integ.provider,
          event: payload.event,
          delivery_id: payload.delivery_id,
          lead_id: payload.lead.id,
          target_url: integ.webhook_url,
          response_status: result.status || null,
          latency_ms: result.latencyMs,
          success: ok,
          signed: !!secret,
          error: result.error ?? null,
        });

        if (!ok) {
          logger.warn(
            {
              integration_id: integ.id,
              provider: integ.provider,
              response_status: result.status,
              error: result.error,
              lead_id: payload.lead.id,
            },
            "Outgoing lead webhook delivery failed",
          );
        }
      }
    } catch (err) {
      logger.error({ err, lead_id: input.lead.id }, "lead webhook dispatcher crashed");
    }
  });
}

/**
 * Send a sample `lead.created` payload to a single integration's
 * `webhook_url` and report the actual HTTP outcome. Used by the
 * integrations admin /test endpoint so the operator can verify their n8n
 * (or Zapier/Make) flow actually receives our events.
 *
 * This DOES make a live HTTP call. The `delivery_id` returned can be
 * cross-referenced against the audit log entry written below.
 */
export async function pingLeadWebhook(integrationId: number): Promise<PingResult> {
  const [row] = await db
    .select()
    .from(integrationsTable)
    .where(eq(integrationsTable.id, integrationId));
  if (!row) return { attempted: false, reason: "not_found" };
  if (row.type !== "automation") return { attempted: false, reason: "wrong_type" };
  if (row.status !== "active") return { attempted: false, reason: "not_active" };
  if (!row.webhook_url) return { attempted: false, reason: "no_webhook_url" };

  const secret = decryptIntegrationApiKey(row);
  const payload: LeadWebhookPayload = {
    event: "lead.created",
    delivery_id: crypto.randomUUID(),
    timestamp: new Date().toISOString(),
    source: "test_ping",
    lead: {
      id: 0,
      name: "Sample Test Lead",
      first_name: "Sample",
      last_name: "Lead",
      email: "sample-lead@example.com",
      state: "CA",
      tort_type: "AFFF / PFAS",
      status: "web_form_intake",
      source: "test_ping",
      created_at: new Date().toISOString(),
    },
  };
  const body = JSON.stringify(payload);
  const headers = buildHeaders(payload, secret, true);
  const result = await postWithTimeout(row.webhook_url, body, headers);

  const ok = result.status >= 200 && result.status < 300;
  await auditLog("integration", "system", "webhook_dispatched", {
    integration_id: row.id,
    provider: row.provider,
    event: payload.event,
    delivery_id: payload.delivery_id,
    lead_id: 0,
    target_url: row.webhook_url,
    response_status: result.status || null,
    latency_ms: result.latencyMs,
    success: ok,
    signed: !!secret,
    test_ping: true,
    error: result.error ?? null,
  });

  return {
    attempted: true,
    response_status: result.status,
    latency_ms: result.latencyMs,
    signed: !!secret,
    delivery_id: payload.delivery_id,
    error: result.error,
  };
}
