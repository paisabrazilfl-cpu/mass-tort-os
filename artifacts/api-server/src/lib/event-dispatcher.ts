/**
 * Generic outbound event dispatcher.
 *
 * Fans out CRM events ({ event, payload }) to every active integration of
 * type `automation` whose `subscribed_events` list (stored in
 * integrations.config.userConfig.subscribed_events) includes the event
 * name. Default subscription set is `["lead.created"]` for backwards
 * compatibility with rows that pre-date this column.
 *
 * Architectural notes (Task #52):
 *  - Non-blocking: every dispatch runs on `setImmediate` so a slow third-
 *    party endpoint can never stall a CRM request.
 *  - Timeout-bounded: per-target HTTP requests cap at 5s.
 *  - Signed: when an integration has an `api_key` stored, payloads are
 *    signed with HMAC-SHA256 and the digest is sent in `X-MTOS-Signature`.
 *  - Audited: every delivery (success and failure) writes one
 *    `audit_log` row with target URL, latency, status, and error text.
 *  - Future-proof: the public surface is a single `dispatchEvent({event,
 *    payload})` so a later change can move delivery onto the existing
 *    `job_queue` worker without touching call sites.
 */
import crypto from "crypto";
import { and, eq } from "drizzle-orm";
import { db, integrationsTable, webhookDeliveriesTable } from "@workspace/db";
import { decrypt } from "./encryption";
import { logger } from "./logger";
import { auditLog } from "./audit";

const DISPATCH_TIMEOUT_MS = 5000;
const SIGNING_FIELD = "api_key";

/** Canonical event names. Add new events here so the type system catches typos at call sites. */
export type CrmEventName =
  | "lead.created"
  | "lead.updated"
  | "ocr.completed"
  | "case.stage_changed";

export interface CrmEvent<P = Record<string, unknown>> {
  event: CrmEventName;
  payload: P;
}

interface IntegrationRow {
  id: number;
  provider: string;
  webhook_url: string | null;
  status: string | null;
  config: unknown;
}

function decryptIntegrationApiKey(row: typeof integrationsTable.$inferSelect): string | null {
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
    const r = await fetch(url, { method: "POST", body, headers, signal: controller.signal });
    return { status: r.status, latencyMs: Date.now() - start };
  } catch (err) {
    return {
      status: 0,
      latencyMs: Date.now() - start,
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    clearTimeout(timer);
  }
}

interface EnvelopeFields {
  event: CrmEventName;
  delivery_id: string;
  timestamp: string;
  isTest: boolean;
}

function buildHeaders(env: EnvelopeFields, secret: string | null, body: string): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "User-Agent": "MTOS-CRM/1.0",
    "X-MTOS-Event": env.event,
    "X-MTOS-Delivery": env.delivery_id,
  };
  if (env.isTest) headers["X-MTOS-Test"] = "true";
  if (secret) headers["X-MTOS-Signature"] = signPayload(secret, body);
  return headers;
}

/**
 * Read the subscribed event list off an integration row. Defaults to
 * ["lead.created"] when unset so legacy rows without this config keep
 * receiving the lead.created stream they already opted into. Operators
 * who explicitly set the array (even to []) get exactly what they
 * asked for.
 */
function subscribedEvents(row: IntegrationRow): readonly string[] {
  const cfg = row.config as { userConfig?: { subscribed_events?: unknown } } | null;
  const raw = cfg?.userConfig?.subscribed_events;
  if (Array.isArray(raw)) return raw.filter((v): v is string => typeof v === "string");
  return ["lead.created"];
}

/**
 * Fire an event to every subscribed automation integration.
 * Fire-and-forget — never throws back to the caller.
 */
export function dispatchEvent<P extends Record<string, unknown>>(
  evt: CrmEvent<P>,
  options: { source?: string; isTest?: boolean } = {},
): void {
  setImmediate(() => {
    void deliverEvent(evt, options).catch((err) => {
      logger.error({ err, event: evt.event }, "event-dispatcher crashed");
    });
  });
}

async function deliverEvent<P extends Record<string, unknown>>(
  evt: CrmEvent<P>,
  options: { source?: string; isTest?: boolean },
): Promise<void> {
  const rows = await db
    .select()
    .from(integrationsTable)
    .where(and(eq(integrationsTable.type, "automation"), eq(integrationsTable.status, "active")));

  const targets = rows.filter(
    (r): r is typeof integrationsTable.$inferSelect & { webhook_url: string } =>
      typeof r.webhook_url === "string" &&
      r.webhook_url.length > 0 &&
      subscribedEvents(r).includes(evt.event),
  );
  if (targets.length === 0) return;

  const env: EnvelopeFields = {
    event: evt.event,
    delivery_id: crypto.randomUUID(),
    timestamp: new Date().toISOString(),
    isTest: !!options.isTest,
  };
  const fullPayload = {
    event: env.event,
    delivery_id: env.delivery_id,
    timestamp: env.timestamp,
    source: options.source ?? "system",
    ...evt.payload,
  };
  const body = JSON.stringify(fullPayload);

  const payloadHash = crypto.createHash("sha256").update(body).digest("hex");

  for (const integ of targets) {
    const secret = decryptIntegrationApiKey(integ);
    const headers = buildHeaders(env, secret, body);
    const result = await postWithTimeout(integ.webhook_url, body, headers);
    const ok = result.status >= 200 && result.status < 300;

    await Promise.all([
      db.insert(webhookDeliveriesTable).values({
        integration_id: integ.id,
        event: env.event,
        delivery_id: env.delivery_id,
        status_code: result.status || null,
        response_ms: result.latencyMs,
        attempt: 1,
        last_error: result.error ?? null,
        payload_hash: payloadHash,
        payload: fullPayload as Record<string, unknown>,
        is_test: env.isTest ? 1 : 0,
      }),
      auditLog("integration", "system", "webhook_dispatched", {
        integration_id: integ.id,
        provider: integ.provider,
        event: env.event,
        delivery_id: env.delivery_id,
        target_url: integ.webhook_url,
        response_status: result.status || null,
        latency_ms: result.latencyMs,
        success: ok,
        signed: !!secret,
        test: env.isTest || undefined,
        error: result.error ?? null,
      }),
    ]);

    if (!ok) {
      logger.warn(
        {
          integration_id: integ.id,
          provider: integ.provider,
          event: env.event,
          response_status: result.status,
          error: result.error,
        },
        "Outbound event delivery failed",
      );
    }
  }
}

/**
 * Send a sample event payload to a single integration's webhook_url and
 * return the live HTTP outcome. Used by the admin /test endpoint.
 */
export async function pingIntegration(
  integrationId: number,
  evt: CrmEvent,
): Promise<{
  attempted: boolean;
  reason?: "no_webhook_url" | "not_active" | "not_found" | "wrong_type";
  response_status?: number;
  latency_ms?: number;
  signed?: boolean;
  delivery_id?: string;
  error?: string;
}> {
  const [row] = await db.select().from(integrationsTable).where(eq(integrationsTable.id, integrationId));
  if (!row) return { attempted: false, reason: "not_found" };
  if (row.type !== "automation") return { attempted: false, reason: "wrong_type" };
  if (row.status !== "active") return { attempted: false, reason: "not_active" };
  if (!row.webhook_url) return { attempted: false, reason: "no_webhook_url" };

  const secret = decryptIntegrationApiKey(row);
  const env: EnvelopeFields = {
    event: evt.event,
    delivery_id: crypto.randomUUID(),
    timestamp: new Date().toISOString(),
    isTest: true,
  };
  const fullPayload = {
    event: env.event,
    delivery_id: env.delivery_id,
    timestamp: env.timestamp,
    source: "test_ping",
    ...evt.payload,
  };
  const body = JSON.stringify(fullPayload);
  const headers = buildHeaders(env, secret, body);
  const result = await postWithTimeout(row.webhook_url, body, headers);
  const ok = result.status >= 200 && result.status < 300;
  const payloadHash = crypto.createHash("sha256").update(body).digest("hex");

  await Promise.all([
    db.insert(webhookDeliveriesTable).values({
      integration_id: row.id,
      event: env.event,
      delivery_id: env.delivery_id,
      status_code: result.status || null,
      response_ms: result.latencyMs,
      attempt: 1,
      last_error: result.error ?? null,
      payload_hash: payloadHash,
      payload: fullPayload as Record<string, unknown>,
      is_test: 1,
    }),
    auditLog("integration", "system", "webhook_dispatched", {
      integration_id: row.id,
      provider: row.provider,
      event: env.event,
      delivery_id: env.delivery_id,
      target_url: row.webhook_url,
      response_status: result.status || null,
      latency_ms: result.latencyMs,
      success: ok,
      signed: !!secret,
      test_ping: true,
      error: result.error ?? null,
    }),
  ]);

  return {
    attempted: true,
    response_status: result.status,
    latency_ms: result.latencyMs,
    signed: !!secret,
    delivery_id: env.delivery_id,
    error: result.error,
  };
}

/** Catalog of events the CRM emits. Returned by /api/admin/event-catalog. */
export const EVENT_CATALOG = [
  {
    event: "lead.created",
    description: "A new lead was created (via API, web form, or operator intake).",
    payload_shape: {
      lead: { id: "number", name: "string|null", first_name: "string|null", last_name: "string|null", email: "string|null", state: "string|null", tort_type: "string|null", status: "string|null", source: "string|null", created_at: "ISO8601 string" },
    },
  },
  {
    event: "lead.updated",
    description: "PATCH /api/leads/:id mutated one or more fields. Use changed_fields to filter (e.g. 'physician_first_name' for the NPI-on-provider-fill workflow).",
    payload_shape: {
      lead_id: "number",
      changed_fields: "string[]",
      new_values: "Partial<Lead> — only the fields included in the PATCH body",
    },
  },
  {
    event: "ocr.completed",
    description: "Worker finished processing a fax/document; OCR fields are now on fax_results.",
    payload_shape: {
      fax_result_id: "number",
      lead_id: "number|null",
      drug_name: "string|null",
      rx_number: "string|null",
      fill_date: "string|null",
      quantity: "string|null",
      confidence: "number|null",
      success: "boolean",
    },
  },
  {
    event: "case.stage_changed",
    description: "casesTable.status was updated (worker analysis or manual route).",
    payload_shape: {
      case_id: "string",
      old_status: "string|null",
      new_status: "string",
      changed_by: "user|worker",
    },
  },
] as const;
