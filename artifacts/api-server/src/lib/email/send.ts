/**
 * Provider-router-backed outbound email send.
 *
 * Routes outbound email through `resolveProvider("email")` so the
 * operator's Workflow Settings choice (or a per-buyer override) drives
 * which provider physically sends the message. Persistence to
 * `email_messages` is handled here uniformly — mirroring the SMS path in
 * `../sms/send.ts` — so adapters stay focused on the wire protocol and
 * every send is durably tracked (queued → sent/failed) and later
 * advanced to delivered/bounced by the provider's Event Webhook.
 */
import { db, emailMessagesTable, leadsTable, workflowSettingsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { resolveProvider, isResolved } from "../provider-router";
import { getEmailAdapter } from "./index";
import { logger } from "../logger";

export interface SendEmailInput {
  to: string;
  toName?: string;
  subject: string;
  html: string;
  text?: string;
  firmId?: number | null;
  leadId?: number | null;
  createdByUserId?: number | null;
  /** Optional explicit integration override (e.g. per-buyer routing). */
  integrationId?: number | null;
  /** Optional buyer for per-buyer email overrides. */
  buyerId?: number | null;
}

export interface SendEmailOutcome {
  ok: boolean;
  emailMessageId?: number;
  externalMessageId?: string;
  provider?: string;
  error?: string;
  /** True when the failure is transient and the caller should retry. */
  retryable?: boolean;
  /**
   * Set when no provider/adapter could be resolved (nothing was queued
   * or attempted). Lets the worker distinguish "misconfigured" from
   * "provider rejected the send".
   */
  reason?: string;
}

/**
 * Resolve the configured email provider, persist a queued email_messages
 * row, dispatch via the chosen adapter, and update the row to sent /
 * failed. Always returns a structured outcome — never throws.
 */
export async function sendEmailViaRouter(input: SendEmailInput): Promise<SendEmailOutcome> {
  const to = input.to.trim();
  if (!to) return { ok: false, error: "Missing destination email address." };

  // Backfill firm/buyer context from the lead when the caller did not
  // supply it, so per-buyer routing and firm-scoped reporting work even
  // for callers that only know the lead id.
  let firmId = input.firmId ?? null;
  let buyerId = input.buyerId ?? null;
  if (input.leadId && (firmId == null || buyerId == null)) {
    const [lead] = await db
      .select({ firm_id: leadsTable.firm_id, buyer_id: leadsTable.buyer_id })
      .from(leadsTable)
      .where(eq(leadsTable.id, input.leadId));
    if (lead) {
      if (firmId == null) firmId = lead.firm_id ?? null;
      if (buyerId == null) buyerId = lead.buyer_id ?? null;
    }
  }

  const resolved = await resolveProvider("email", {
    explicitIntegrationId: input.integrationId ?? null,
    buyerId: buyerId ?? null,
  });
  if (!isResolved(resolved)) {
    return { ok: false, reason: resolved.reason, error: resolved.details ?? resolved.reason };
  }

  const adapter = getEmailAdapter(resolved.provider);
  if (!adapter) {
    return {
      ok: false,
      reason: "no_adapter",
      error: `No email adapter implemented for provider "${resolved.provider}".`,
    };
  }

  // Resolve the "from" identity: integration credential first, then the
  // global Workflow Settings default, then a last-resort placeholder.
  const globalSettings = await db
    .select({
      fromAddress: workflowSettingsTable.default_email_from_address,
      fromName: workflowSettingsTable.default_email_from_name,
    })
    .from(workflowSettingsTable)
    .where(eq(workflowSettingsTable.scope, "global"))
    .limit(1)
    .then((r) => r[0] ?? null);

  const fromEmail =
    (typeof resolved.credentials.from_email === "string" ? resolved.credentials.from_email : "") ||
    globalSettings?.fromAddress ||
    "noreply@example.com";
  const fromName =
    (typeof resolved.credentials.from_name === "string" ? resolved.credentials.from_name : "") ||
    globalSettings?.fromName ||
    "MTOS";

  const [inserted] = await db
    .insert(emailMessagesTable)
    .values({
      firm_id: firmId,
      lead_id: input.leadId ?? null,
      direction: "outbound",
      from_email: fromEmail.slice(0, 320),
      to_email: to.slice(0, 320),
      to_name: input.toName ? input.toName.slice(0, 255) : null,
      subject: input.subject.slice(0, 998),
      provider: resolved.provider,
      status: "queued",
      created_by_user_id: input.createdByUserId ?? null,
    })
    .returning({ id: emailMessagesTable.id });
  const emailMessageId = inserted!.id;

  try {
    const out = await adapter.send(resolved.credentials, {
      to,
      toName: input.toName,
      fromEmail,
      fromName,
      subject: input.subject,
      html: input.html,
      text: input.text,
    });

    if (!out.ok) {
      await db
        .update(emailMessagesTable)
        .set({ status: "failed", error: out.message, failed_at: new Date(), updated_at: new Date() })
        .where(eq(emailMessagesTable.id, emailMessageId));
      logger.warn({ emailMessageId, provider: resolved.provider, code: out.code }, "email send failed");
      return {
        ok: false,
        emailMessageId,
        provider: resolved.provider,
        error: out.message,
        retryable: out.retryable,
      };
    }

    await db
      .update(emailMessagesTable)
      .set({
        status: "sent",
        sent_at: new Date(),
        updated_at: new Date(),
        external_message_id: out.externalMessageId ?? null,
      })
      .where(eq(emailMessagesTable.id, emailMessageId));

    return {
      ok: true,
      emailMessageId,
      externalMessageId: out.externalMessageId,
      provider: resolved.provider,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    await db
      .update(emailMessagesTable)
      .set({ status: "failed", error: message, failed_at: new Date(), updated_at: new Date() })
      .where(eq(emailMessagesTable.id, emailMessageId));
    logger.error({ err, emailMessageId, provider: resolved.provider }, "email send threw");
    return { ok: false, emailMessageId, provider: resolved.provider, error: message };
  }
}
