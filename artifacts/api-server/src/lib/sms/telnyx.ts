/**
 * Telnyx SMS adapter — outbound send + inbound webhook signature verify.
 *
 * Telnyx Messaging API auth uses a v2 API key (saved in vault as
 * `api_key`). Inbound webhook signatures use Ed25519: the public key
 * is stored in vault as `client_secret`. See
 * https://developers.telnyx.com/docs/messaging/webhooks for the spec.
 *
 * The integration vault preset for telnyx_sms must be added in
 * integration-presets.ts; this adapter consumes those credentials.
 */
import { db, integrationsTable, smsMessagesTable } from "@workspace/db";
import { and, eq } from "drizzle-orm";
import crypto from "crypto";
import { getIntegrationCredentialsById } from "../../routes/integrations";
import { logger } from "../logger";

export interface TelnyxCredentials {
  apiKey: string;
  publicKey: string | null;
  fromNumber: string | null;
  messagingProfileId: string | null;
  integrationId: number;
}

export async function loadTelnyxSmsCredentials(): Promise<TelnyxCredentials | null> {
  const rows = await db
    .select({ id: integrationsTable.id })
    .from(integrationsTable)
    .where(
      and(
        eq(integrationsTable.provider, "telnyx_sms"),
        eq(integrationsTable.status, "active"),
      ),
    )
    .limit(1);
  const row = rows[0];
  if (!row) return null;

  const creds = await getIntegrationCredentialsById(row.id);
  if (!creds) return null;
  if (creds._decryption_errors && creds._decryption_errors.length) {
    logger.error(
      { fields: creds._decryption_errors, integration_id: row.id },
      "telnyx_sms credential decryption failed",
    );
    return null;
  }
  const apiKey = typeof creds.api_key === "string" ? creds.api_key.trim() : "";
  if (!apiKey) return null;
  // from_number and messaging_profile_id are non-secret operator config —
  // they live in `config` (userConfig), not in the encrypted secret fields.
  const cfg = (creds.config && typeof creds.config === "object" ? creds.config : {}) as Record<string, unknown>;
  const fromNumberRaw = typeof cfg.from_number === "string" ? cfg.from_number.trim() : "";
  const profileIdRaw = typeof cfg.messaging_profile_id === "string" ? cfg.messaging_profile_id.trim() : "";
  return {
    apiKey,
    publicKey:
      typeof creds.client_secret === "string" && creds.client_secret.trim().length > 0
        ? creds.client_secret.trim()
        : null,
    fromNumber: fromNumberRaw.length > 0 ? fromNumberRaw : null,
    messagingProfileId: profileIdRaw.length > 0 ? profileIdRaw : null,
    integrationId: row.id,
  };
}

export interface SendSmsInput {
  to: string;
  body: string;
  firmId?: number | null;
  leadId?: number | null;
  createdByUserId?: number | null;
}

export interface SendSmsResult {
  ok: boolean;
  smsMessageId?: number;
  telnyxMessageId?: string;
  error?: string;
}

/**
 * Send a single SMS via Telnyx Messaging API. Persists an sms_messages
 * row up-front in status="queued", then updates to "sent" on success or
 * "failed" on error. The webhook handler later moves it to
 * "delivered"/"failed_delivery".
 */
export async function sendSms(input: SendSmsInput): Promise<SendSmsResult> {
  const to = normalizeE164(input.to);
  if (!to) {
    return { ok: false, error: "Invalid destination phone — must be E.164 (+15551234567)." };
  }

  const creds = await loadTelnyxSmsCredentials();
  if (!creds) {
    return { ok: false, error: "Telnyx SMS is not configured. Add a Telnyx SMS integration." };
  }
  if (!creds.fromNumber && !creds.messagingProfileId) {
    return {
      ok: false,
      error:
        "Telnyx SMS integration must have either from_number or messaging_profile_id set.",
    };
  }

  // Persist queued row first so we have an id to reference in the webhook.
  const [inserted] = await db
    .insert(smsMessagesTable)
    .values({
      firm_id: input.firmId ?? null,
      lead_id: input.leadId ?? null,
      direction: "outbound",
      from_phone_e164: creds.fromNumber,
      to_phone_e164: to,
      body: input.body,
      status: "queued",
      created_by_user_id: input.createdByUserId ?? null,
    })
    .returning({ id: smsMessagesTable.id });
  const smsMessageId = inserted!.id;

  try {
    const payload: Record<string, unknown> = {
      to,
      text: input.body,
    };
    if (creds.fromNumber) payload.from = creds.fromNumber;
    if (creds.messagingProfileId) payload.messaging_profile_id = creds.messagingProfileId;

    const resp = await fetch("https://api.telnyx.com/v2/messages", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${creds.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });
    const json = (await resp.json().catch(() => ({}))) as {
      data?: { id?: string };
      errors?: Array<{ detail?: string }>;
    };

    if (!resp.ok || !json?.data?.id) {
      const detail = json?.errors?.[0]?.detail ?? `HTTP ${resp.status}`;
      await db
        .update(smsMessagesTable)
        .set({ status: "failed", error: detail, failed_at: new Date(), updated_at: new Date() })
        .where(eq(smsMessagesTable.id, smsMessageId));
      logger.error({ smsMessageId, detail }, "telnyx send failed");
      return { ok: false, smsMessageId, error: detail };
    }

    const telnyxMessageId = json.data.id;
    await db
      .update(smsMessagesTable)
      .set({
        status: "sent",
        telnyx_message_id: telnyxMessageId,
        sent_at: new Date(),
        updated_at: new Date(),
      })
      .where(eq(smsMessagesTable.id, smsMessageId));

    return { ok: true, smsMessageId, telnyxMessageId };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    await db
      .update(smsMessagesTable)
      .set({ status: "failed", error: message, failed_at: new Date(), updated_at: new Date() })
      .where(eq(smsMessagesTable.id, smsMessageId));
    logger.error({ err, smsMessageId }, "telnyx send threw");
    return { ok: false, smsMessageId, error: message };
  }
}

/**
 * Verify a Telnyx webhook signature. Telnyx signs with Ed25519 — header
 * `telnyx-signature-ed25519` carries the base64-encoded signature, and
 * `telnyx-timestamp` is the unix ts; the signed payload is
 * `<timestamp>|<rawBody>`.
 *
 * Returns true when the signature verifies AND the timestamp is fresh
 * (within 5 minutes). Returns false otherwise; the caller must always
 * 200 the webhook.
 */
export async function verifyTelnyxSignature(
  rawBody: Buffer,
  headers: Record<string, string | string[] | undefined>,
): Promise<boolean> {
  const creds = await loadTelnyxSmsCredentials();
  if (!creds?.publicKey) return false;

  const signature = pickHeader(headers, "telnyx-signature-ed25519");
  const timestamp = pickHeader(headers, "telnyx-timestamp");
  if (!signature || !timestamp) return false;

  // Freshness check (5 min)
  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(Date.now() / 1000 - ts) > 300) return false;

  try {
    const signed = Buffer.concat([Buffer.from(`${timestamp}|`), rawBody]);
    const sigBuf = Buffer.from(signature, "base64");
    const pubKey = crypto.createPublicKey({
      key: Buffer.concat([
        // Ed25519 SubjectPublicKeyInfo prefix: 12 bytes ASN.1 header for raw 32-byte key.
        Buffer.from("302a300506032b6570032100", "hex"),
        Buffer.from(creds.publicKey, "base64"),
      ]),
      format: "der",
      type: "spki",
    });
    return crypto.verify(null, signed, pubKey, sigBuf);
  } catch (err) {
    logger.warn({ err }, "telnyx signature verify threw");
    return false;
  }
}

function normalizeE164(raw: string): string | null {
  const trimmed = raw.trim();
  if (/^\+\d{8,15}$/.test(trimmed)) return trimmed;
  const digits = trimmed.replace(/\D/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return null;
}

function pickHeader(
  headers: Record<string, string | string[] | undefined>,
  name: string,
): string | undefined {
  const value = headers[name] ?? headers[name.toLowerCase()];
  if (Array.isArray(value)) return value[0];
  return value;
}
