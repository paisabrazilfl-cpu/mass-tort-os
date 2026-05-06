/**
 * Provider-router-backed outbound SMS send.
 *
 * Routes outbound SMS through `resolveProvider("sms")` so the operator's
 * Workflow Settings choice (or the Telnyx default fallback when no FK
 * is configured) drives which provider physically sends the message.
 * Persistence to sms_messages is handled here uniformly so adapters
 * stay focused on the wire protocol.
 */
import { db, smsMessagesTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { resolveProvider, isResolved } from "../provider-router";
import { getSmsAdapter } from "./index";
import { logger } from "../logger";

export interface SendSmsInput {
  to: string;
  body: string;
  firmId?: number | null;
  leadId?: number | null;
  createdByUserId?: number | null;
  /** Optional explicit integration override (e.g. per-buyer routing). */
  integrationId?: number | null;
  /** Optional buyer for per-buyer fax/email overrides. */
  buyerId?: number | null;
}

export interface SendSmsOutcome {
  ok: boolean;
  smsMessageId?: number;
  externalMessageId?: string;
  provider?: string;
  error?: string;
}

function normalizeE164(raw: string): string | null {
  const trimmed = raw.trim();
  if (/^\+\d{8,15}$/.test(trimmed)) return trimmed;
  const digits = trimmed.replace(/\D/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return null;
}

/**
 * Resolve the configured SMS provider, persist a queued sms_messages
 * row, dispatch via the chosen adapter, and update the row to sent /
 * failed. Always returns a structured outcome — never throws.
 */
export async function sendSmsViaRouter(input: SendSmsInput): Promise<SendSmsOutcome> {
  const to = normalizeE164(input.to);
  if (!to) return { ok: false, error: "Invalid destination phone — must be E.164 (+15551234567)." };

  const resolved = await resolveProvider("sms", {
    explicitIntegrationId: input.integrationId ?? null,
    buyerId: input.buyerId ?? null,
  });
  if (!isResolved(resolved)) {
    return { ok: false, error: `SMS provider not available: ${resolved.reason} — ${resolved.details ?? ""}` };
  }

  const adapter = getSmsAdapter(resolved.provider);
  if (!adapter) {
    return { ok: false, error: `No SMS adapter implemented for provider "${resolved.provider}".` };
  }

  // Read the operator's configured "from" number from the integration's
  // user-config blob (every preset stores it under config.from_number).
  const cfg = (resolved.credentials.config && typeof resolved.credentials.config === "object"
    ? resolved.credentials.config
    : {}) as Record<string, unknown>;
  const fromNumber = typeof cfg.from_number === "string" && cfg.from_number.trim().length > 0
    ? cfg.from_number.trim()
    : null;

  const [inserted] = await db
    .insert(smsMessagesTable)
    .values({
      firm_id: input.firmId ?? null,
      lead_id: input.leadId ?? null,
      direction: "outbound",
      from_phone_e164: fromNumber,
      to_phone_e164: to,
      body: input.body,
      status: "queued",
      created_by_user_id: input.createdByUserId ?? null,
    })
    .returning({ id: smsMessagesTable.id });
  const smsMessageId = inserted!.id;

  try {
    const out = await adapter.send(resolved.credentials, { to, body: input.body });
    if (!out.ok) {
      await db
        .update(smsMessagesTable)
        .set({ status: "failed", error: out.message, failed_at: new Date(), updated_at: new Date() })
        .where(eq(smsMessagesTable.id, smsMessageId));
      logger.warn({ smsMessageId, provider: resolved.provider, code: out.code }, "sms send failed");
      return { ok: false, smsMessageId, provider: resolved.provider, error: out.message };
    }

    const updates: Record<string, unknown> = {
      status: "sent",
      sent_at: new Date(),
      updated_at: new Date(),
    };
    // Telnyx historically populated a dedicated column; for everything
    // else the external id lives in raw_payload via the webhook handler.
    if (resolved.provider === "telnyx") updates.telnyx_message_id = out.externalMessageId;
    await db.update(smsMessagesTable).set(updates).where(eq(smsMessagesTable.id, smsMessageId));

    return {
      ok: true,
      smsMessageId,
      externalMessageId: out.externalMessageId,
      provider: resolved.provider,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    await db
      .update(smsMessagesTable)
      .set({ status: "failed", error: message, failed_at: new Date(), updated_at: new Date() })
      .where(eq(smsMessagesTable.id, smsMessageId));
    logger.error({ err, smsMessageId, provider: resolved.provider }, "sms send threw");
    return { ok: false, smsMessageId, provider: resolved.provider, error: message };
  }
}
