/**
 * E-sign provider webhook receivers.
 * These endpoints are PUBLIC (no auth middleware) because providers cannot send our session cookie.
 * Each provider authenticates differently — we verify per-provider before mutating state.
 *
 * Wired into routes/index.ts as router.use("/webhooks", webhooksRouter).
 *
 * On a verified "signed" event we:
 *   1. Update document_envelopes.status, signed_at, append events
 *   2. Call workflow-engine.onEnvelopeSigned() to potentially enqueue the doctor fax
 *
 * NEVER throw — webhooks must always 200 OK so the provider doesn't endlessly retry.
 * Errors are logged + audited.
 */
import { Router } from "express";
import {
  db,
  documentEnvelopesTable,
  integrationsTable,
  firmsTable,
  callLogsTable,
  smsMessagesTable,
  leadDispositionsTable,
} from "@workspace/db";
import { eq, sql } from "drizzle-orm";
import crypto from "crypto";
import { logger } from "../lib/logger";
import { auditLog } from "../lib/audit";
import { onEnvelopeSigned } from "../lib/workflow-engine";
import { getIntegrationCredentialsById } from "./integrations";
import { badRequest, notFound } from "../lib/http-errors";
import { verifyWebhook as verifyStripeWebhook } from "../lib/payments/stripe";
import { verifyVapiSignature } from "../lib/voice/vapi";
import { verifyTelnyxSignature } from "../lib/sms/telnyx";
import { invalidateStripeConfiguredCache } from "../lib/subscription-gate";
import type Stripe from "stripe";

const router: ReturnType<typeof Router> = Router();

interface NormalizedEvent {
  externalEnvelopeId: string;
  status: "viewed" | "signed" | "declined" | "delivered" | "voided" | "expired" | "error";
  rawType: string;
  raw: Record<string, unknown>;
}

/**
 * Apply a normalized envelope event to the DB and trigger downstream side-effects.
 */
async function applyEnvelopeEvent(provider: string, evt: NormalizedEvent): Promise<void> {
  const [env] = await db
    .select()
    .from(documentEnvelopesTable)
    .where(eq(documentEnvelopesTable.external_envelope_id, evt.externalEnvelopeId));

  if (!env) {
    logger.warn(
      { provider, external_id: evt.externalEnvelopeId, status: evt.status },
      "Webhook event for unknown envelope — ignoring",
    );
    return;
  }

  const now = new Date();
  const newEvents = [
    ...(env.events || []),
    { type: evt.rawType, at: now.toISOString(), raw: evt.raw },
  ];

  const update: Record<string, unknown> = {
    status: evt.status,
    events: newEvents,
    updated_at: now,
  };
  if (evt.status === "viewed" && !env.viewed_at) update.viewed_at = now;
  if (evt.status === "delivered" && !env.delivered_at) update.delivered_at = now;
  if (evt.status === "signed") update.signed_at = now;
  if (evt.status === "declined") update.declined_at = now;

  await db
    .update(documentEnvelopesTable)
    .set(update)
    .where(eq(documentEnvelopesTable.id, env.id));

  await auditLog("document_envelope", String(env.id), `webhook_${evt.rawType}`, {
    provider,
    status: evt.status,
    external_id: evt.externalEnvelopeId,
  });

  if (evt.status === "signed") {
    try {
      const result = await onEnvelopeSigned(env.id);
      logger.info(
        { envelope_id: env.id, fax_job_id: result.enqueued_fax_job_id, reason: result.reason },
        "onEnvelopeSigned handled",
      );
    } catch (err) {
      logger.error({ err, envelope_id: env.id }, "onEnvelopeSigned threw — ignoring to keep webhook 200");
    }
  }
}

/**
 * Find the active integration row for a given provider so we can fetch its webhook secret.
 * If multiple are active we just take the first; admins are advised to keep one per provider.
 */
async function loadProviderSecret(provider: string, secretField: string): Promise<string | null> {
  const rows = await db
    .select()
    .from(integrationsTable)
    .where(eq(integrationsTable.provider, provider));
  for (const row of rows) {
    if (row.status !== "active") continue;
    const creds = await getIntegrationCredentialsById(row.id);
    const val = creds && (creds as Record<string, unknown>)[secretField];
    if (typeof val === "string" && val.length > 0) return val;
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────
// Dropbox Sign (HelloSign) webhook
//   Auth: HMAC-SHA256 of the JSON body using API key as the secret.
//   See https://developers.hellosign.com/api/reference/webhook
// ─────────────────────────────────────────────────────────────────

router.post("/dropbox-sign", async (req, res) => {
  // Dropbox Sign requires us to respond exactly with this body for handshake/test:
  const handshakeBody = "Hello API Event Received";

  try {
    const payload = req.body?.json ? JSON.parse(req.body.json) : req.body;
    const event = payload?.event || {};
    const eventType: string = event.event_type || "";
    const eventHash: string = event.event_hash || "";

    const apiKey = await loadProviderSecret("dropbox_sign", "api_key");
    // STRICT: if a Dropbox Sign integration is configured, every event must carry a valid signature.
    // Missing or wrong signature → ack 200 but DO NOT mutate state.
    if (apiKey) {
      if (!eventType || !eventHash) {
        logger.warn({ provider: "dropbox_sign" }, "Dropbox Sign webhook missing signature fields — refusing state mutation");
        res.status(200).type("text/plain").send(handshakeBody);
        return;
      }
      const expected = crypto
        .createHmac("sha256", apiKey)
        .update(`${eventType}${event.event_time || ""}`)
        .digest("hex");
      if (expected !== eventHash) {
        logger.warn({ provider: "dropbox_sign" }, "Dropbox Sign webhook signature mismatch");
        res.status(200).type("text/plain").send(handshakeBody);
        return;
      }
    } else {
      // No active integration configured → don't mutate state from anonymous traffic.
      logger.warn({ provider: "dropbox_sign" }, "Dropbox Sign webhook received but no active integration configured — ignoring");
      res.status(200).type("text/plain").send(handshakeBody);
      return;
    }

    const sigReq = payload?.signature_request || {};
    const externalId: string = sigReq.signature_request_id;
    if (!externalId) {
      res.status(200).type("text/plain").send(handshakeBody);
      return;
    }

    let normalizedStatus: NormalizedEvent["status"] = "delivered";
    if (eventType === "signature_request_viewed") normalizedStatus = "viewed";
    else if (eventType === "signature_request_signed") normalizedStatus = "signed";
    else if (eventType === "signature_request_all_signed") normalizedStatus = "signed";
    else if (eventType === "signature_request_declined") normalizedStatus = "declined";
    else if (eventType === "signature_request_canceled") normalizedStatus = "voided";
    else if (eventType === "signature_request_expired") normalizedStatus = "expired";
    else if (eventType === "signature_request_sent") normalizedStatus = "delivered";
    else {
      // Unhandled type — log and ack.
      logger.info({ event_type: eventType }, "Dropbox Sign webhook: unhandled event_type");
      res.status(200).type("text/plain").send(handshakeBody);
      return;
    }

    await applyEnvelopeEvent("dropbox_sign", {
      externalEnvelopeId: externalId,
      status: normalizedStatus,
      rawType: eventType,
      raw: payload,
    });

    res.status(200).type("text/plain").send(handshakeBody);
  } catch (err) {
    logger.error({ err }, "Dropbox Sign webhook handler error");
    res.status(200).type("text/plain").send(handshakeBody);
  }
});

// ─────────────────────────────────────────────────────────────────
// DocuSign Connect webhook
//   Auth: HMAC-SHA256 of the raw body, header X-DocuSign-Signature-1, secret from integration.
//   See https://developers.docusign.com/platform/webhooks/connect/hmac/
// ─────────────────────────────────────────────────────────────────

router.post("/docusign", async (req, res) => {
  try {
    const provided = req.header("x-docusign-signature-1") || "";
    const hmacSecret = await loadProviderSecret("docusign", "webhook_hmac_secret");
    // STRICT: if DocuSign integration is configured we require a valid signature
    // before mutating any envelope. Bad signature => 200 ack but no-op.
    if (hmacSecret) {
      if (!provided) {
        logger.warn({ provider: "docusign" }, "DocuSign webhook missing X-DocuSign-Signature-1 header — refusing state mutation");
        res.status(200).json({ ok: true, note: "missing_signature" });
        return;
      }
      // CRITICAL: HMAC must run against the EXACT bytes the provider signed.
      // `JSON.stringify(req.body)` re-serializes after parsing, which reorders
      // keys and changes whitespace — that silently breaks signature checks
      // even on legitimate callbacks. We capture `rawBody` in app.ts via the
      // express.json verify hook for /api/webhooks/* and use it here.
      const rawBody = (req as unknown as { rawBody?: Buffer }).rawBody;
      if (!rawBody || rawBody.length === 0) {
        // Fallback for the (rare) case where body-parser ran but didn't capture
        // raw bytes (e.g. the raw-body capture was misconfigured upstream).
        // Logging a hard warning lets ops detect a bad deploy rather than
        // silently letting bad signatures through.
        logger.error(
          { provider: "docusign" },
          "DocuSign webhook: rawBody not captured — signature verification cannot be trusted; refusing state mutation",
        );
        res.status(200).json({ ok: true, note: "raw_body_unavailable" });
        return;
      }
      const expected = crypto.createHmac("sha256", hmacSecret).update(rawBody).digest("base64");
      // Constant-time compare to defeat timing attacks. Both must be the same length
      // for timingSafeEqual; if not, the signature is automatically wrong.
      const expectedBuf = Buffer.from(expected, "utf8");
      const providedBuf = Buffer.from(provided, "utf8");
      const sigOk =
        expectedBuf.length === providedBuf.length &&
        crypto.timingSafeEqual(expectedBuf, providedBuf);
      if (!sigOk) {
        logger.warn({ provider: "docusign" }, "DocuSign webhook signature mismatch — refusing state mutation");
        res.status(200).json({ ok: true, note: "bad_signature" });
        return;
      }
    } else {
      logger.warn({ provider: "docusign" }, "DocuSign webhook received but no active integration configured — ignoring");
      res.status(200).json({ ok: true, note: "no_integration" });
      return;
    }

    const data = req.body?.data || req.body || {};
    const externalId: string = data.envelopeId || data.envelope_id || data.envelopeSummary?.envelopeId;
    const docusignStatus: string = (data.envelopeSummary?.status || data.status || "").toLowerCase();

    if (!externalId) {
      res.status(200).json({ ok: true, note: "no envelopeId in payload" });
      return;
    }

    let normalizedStatus: NormalizedEvent["status"] = "delivered";
    switch (docusignStatus) {
      case "delivered": normalizedStatus = "delivered"; break;
      case "sent":      normalizedStatus = "delivered"; break;
      case "completed": normalizedStatus = "signed"; break;
      case "signed":    normalizedStatus = "signed"; break;
      case "declined":  normalizedStatus = "declined"; break;
      case "voided":    normalizedStatus = "voided"; break;
      case "expired":   normalizedStatus = "expired"; break;
      case "viewed":    normalizedStatus = "viewed"; break;
      default:
        logger.info({ docusign_status: docusignStatus }, "DocuSign webhook: unhandled status");
        res.status(200).json({ ok: true, note: "unhandled status" });
        return;
    }

    await applyEnvelopeEvent("docusign", {
      externalEnvelopeId: externalId,
      status: normalizedStatus,
      rawType: `docusign.${docusignStatus}`,
      raw: req.body,
    });

    res.status(200).json({ ok: true });
  } catch (err) {
    logger.error({ err }, "DocuSign webhook handler error");
    res.status(200).json({ ok: true, note: "handler_error_logged" });
  }
});

// ─────────────────────────────────────────────────────────────────
// Stripe webhook
//   Auth: Stripe-Signature header verified via constructEvent against
//   the webhook signing secret (stored on integrations vault as
//   `client_secret` of the stripe row). Updates firms row state.
// ─────────────────────────────────────────────────────────────────

router.post("/stripe", async (req, res) => {
  const sig = req.header("stripe-signature");
  const rawBody = (req as unknown as { rawBody?: Buffer }).rawBody;
  if (!sig || !rawBody) {
    logger.warn("stripe webhook: missing signature or raw body");
    res.status(200).json({ ok: true, note: "missing_signature" });
    return;
  }

  let event: Stripe.Event;
  try {
    event = await verifyStripeWebhook(rawBody, sig);
  } catch (err) {
    logger.warn({ err }, "stripe webhook signature verify failed");
    res.status(200).json({ ok: true, note: "invalid_signature" });
    return;
  }

  try {
    await applyStripeEvent(event);
  } catch (err) {
    logger.error({ err, type: event.type }, "stripe event apply failed");
  }
  // Stripe creds may have changed (e.g. new integration row activated)
  // — bust the gate's "is configured" cache so the next request re-checks.
  invalidateStripeConfiguredCache();
  res.status(200).json({ ok: true, received: event.type });
});

async function applyStripeEvent(event: Stripe.Event): Promise<void> {
  switch (event.type) {
    case "checkout.session.completed": {
      const session = event.data.object as Stripe.Checkout.Session;
      const firmId = Number(
        session.client_reference_id ?? (session.metadata?.firm_id as string | undefined),
      );
      if (!Number.isFinite(firmId) || firmId <= 0) {
        logger.warn({ session_id: session.id }, "stripe checkout.session.completed without firm_id");
        return;
      }
      const customerId =
        typeof session.customer === "string" ? session.customer : session.customer?.id ?? null;
      const subscriptionId =
        typeof session.subscription === "string"
          ? session.subscription
          : session.subscription?.id ?? null;
      await db
        .update(firmsTable)
        .set({
          stripe_customer_id: customerId,
          stripe_subscription_id: subscriptionId,
          subscription_status: "active",
          updated_at: new Date(),
        })
        .where(eq(firmsTable.id, firmId));
      return;
    }
    case "customer.subscription.created":
    case "customer.subscription.updated":
    case "customer.subscription.deleted": {
      const sub = event.data.object as Stripe.Subscription;
      const firmId = Number(sub.metadata?.firm_id);
      const customerId = typeof sub.customer === "string" ? sub.customer : sub.customer?.id ?? null;

      // Stripe API reshape: `current_period_end` lives on the subscription
      // item in newer API versions but on the subscription itself in older
      // ones. Read the typed property when present, otherwise fall back to
      // the first item's price period.
      const subAny = sub as unknown as Record<string, unknown>;
      const cpeRaw = (subAny.current_period_end as number | undefined) ??
        (sub.items?.data?.[0] as unknown as { current_period_end?: number } | undefined)?.current_period_end ??
        null;
      const periodEnd = cpeRaw ? new Date(cpeRaw * 1000) : null;
      const planPriceId = sub.items?.data?.[0]?.price?.id ?? null;

      const updates = {
        stripe_subscription_id: sub.id,
        subscription_status: event.type === "customer.subscription.deleted" ? "canceled" : sub.status,
        current_period_end: periodEnd,
        plan_price_id: planPriceId,
        updated_at: new Date(),
      };
      if (Number.isFinite(firmId) && firmId > 0) {
        await db.update(firmsTable).set(updates).where(eq(firmsTable.id, firmId));
      } else if (customerId) {
        await db
          .update(firmsTable)
          .set(updates)
          .where(eq(firmsTable.stripe_customer_id, customerId));
      } else {
        logger.warn({ event_type: event.type, sub_id: sub.id }, "stripe subscription event without firm anchor");
      }
      return;
    }
    case "invoice.payment_succeeded":
    case "invoice.payment_failed": {
      const inv = event.data.object as Stripe.Invoice;
      const customerId = typeof inv.customer === "string" ? inv.customer : inv.customer?.id ?? null;
      if (!customerId) return;
      const status = event.type === "invoice.payment_succeeded" ? "active" : "past_due";
      await db
        .update(firmsTable)
        .set({ subscription_status: status, updated_at: new Date() })
        .where(eq(firmsTable.stripe_customer_id, customerId));
      return;
    }
    default:
      logger.info({ type: event.type }, "stripe webhook: unhandled event type");
  }
}

// ─────────────────────────────────────────────────────────────────
// Vapi voice webhook
//   Auth: HMAC-SHA256 of raw body OR static bearer (verifyVapiSignature).
//   Events: call-started, transcript, call-ended, intake-result, escalate-human.
// ─────────────────────────────────────────────────────────────────

router.post("/vapi", async (req, res) => {
  const rawBody = (req as unknown as { rawBody?: Buffer }).rawBody;
  if (!rawBody) {
    res.status(200).json({ ok: true, note: "no_raw_body" });
    return;
  }

  const sig = await verifyVapiSignature(rawBody, req.headers as Record<string, string | string[] | undefined>);
  if (!sig.ok) {
    logger.warn({ reason: sig.reason }, "vapi webhook signature failed");
    res.status(200).json({ ok: true, note: sig.reason ?? "unverified" });
    return;
  }

  try {
    await applyVapiEvent(req.body);
  } catch (err) {
    logger.error({ err }, "vapi event apply failed");
  }
  res.status(200).json({ ok: true });
});

interface VapiEventPayload {
  type?: string;
  call?: {
    id?: string;
    status?: string;
    customer?: { number?: string };
    assistant?: { id?: string };
    startedAt?: string;
    endedAt?: string;
    recordingUrl?: string;
    metadata?: Record<string, unknown>;
  };
  message?: {
    type?: string;
    role?: string;
    content?: string;
    transcript?: string;
    timestamp?: string;
  };
  artifact?: {
    transcript?: unknown[];
    recordingUrl?: string;
  };
  result?: Record<string, unknown>;
}

async function applyVapiEvent(body: unknown): Promise<void> {
  const payload = (body ?? {}) as VapiEventPayload;
  const evtType = String(payload.type ?? payload.message?.type ?? "");
  const call = payload.call;
  const vapiCallId = call?.id;
  if (!vapiCallId) {
    logger.warn({ evtType }, "vapi event missing call.id");
    return;
  }

  // Resolve / upsert the call_logs row.
  const existing = await db
    .select()
    .from(callLogsTable)
    .where(eq(callLogsTable.vapi_call_id, vapiCallId))
    .limit(1);
  let row = existing[0];

  const firmId = Number(call?.metadata?.firm_id);
  const leadId = Number(call?.metadata?.lead_id);

  if (!row) {
    const [inserted] = await db
      .insert(callLogsTable)
      .values({
        firm_id: Number.isFinite(firmId) && firmId > 0 ? firmId : null,
        lead_id: Number.isFinite(leadId) && leadId > 0 ? leadId : null,
        vapi_call_id: vapiCallId,
        direction: "inbound",
        from_number: call?.customer?.number ?? null,
        status: "in_progress",
        started_at: call?.startedAt ? new Date(call.startedAt) : new Date(),
        events: [{ type: evtType, ts: new Date().toISOString(), payload }] as unknown[],
      })
      .returning();
    row = inserted!;
  } else {
    await db
      .update(callLogsTable)
      .set({
        events: sql`${callLogsTable.events} || ${JSON.stringify([
          { type: evtType, ts: new Date().toISOString(), payload },
        ])}::jsonb`,
        updated_at: new Date(),
      })
      .where(eq(callLogsTable.id, row.id));
  }

  // Per-event-type side effects.
  switch (evtType) {
    case "call-start":
    case "call-started": {
      await db
        .update(callLogsTable)
        .set({ status: "in_progress", started_at: call?.startedAt ? new Date(call.startedAt) : new Date(), updated_at: new Date() })
        .where(eq(callLogsTable.id, row.id));
      return;
    }
    case "transcript": {
      const turn = {
        role: payload.message?.role ?? "unknown",
        content: payload.message?.transcript ?? payload.message?.content ?? "",
        ts: payload.message?.timestamp ?? new Date().toISOString(),
      };
      await db
        .update(callLogsTable)
        .set({
          transcript: sql`${callLogsTable.transcript} || ${JSON.stringify([turn])}::jsonb`,
          updated_at: new Date(),
        })
        .where(eq(callLogsTable.id, row.id));
      return;
    }
    case "end-of-call-report":
    case "call-ended": {
      const startedAt = row.started_at ?? (call?.startedAt ? new Date(call.startedAt) : null);
      const endedAt = call?.endedAt ? new Date(call.endedAt) : new Date();
      const duration = startedAt ? Math.max(0, Math.round((endedAt.getTime() - startedAt.getTime()) / 1000)) : null;
      await db
        .update(callLogsTable)
        .set({
          status: "completed",
          ended_at: endedAt,
          duration_seconds: duration,
          recording_url: payload.artifact?.recordingUrl ?? call?.recordingUrl ?? row.recording_url,
          transcript: payload.artifact?.transcript
            ? (payload.artifact.transcript as unknown[])
            : row.transcript,
          updated_at: new Date(),
        })
        .where(eq(callLogsTable.id, row.id));
      return;
    }
    case "intake-result": {
      await db
        .update(callLogsTable)
        .set({ intake_result: payload.result ?? null, updated_at: new Date() })
        .where(eq(callLogsTable.id, row.id));
      return;
    }
    case "escalate-human": {
      if (row.lead_id) {
        await db.insert(leadDispositionsTable).values({
          firm_id: row.firm_id,
          lead_id: row.lead_id,
          disposition: "human_review",
          reason: typeof payload.result?.reason === "string" ? payload.result.reason : "vapi_escalation",
          source: "vapi",
        });
      }
      return;
    }
    default:
      // Already appended to events; nothing else to do.
      return;
  }
}

// ─────────────────────────────────────────────────────────────────
// Telnyx SMS delivery webhook
//   Auth: Ed25519 signature (verifyTelnyxSignature).
//   Updates sms_messages.status based on Telnyx delivery events.
// ─────────────────────────────────────────────────────────────────

router.post("/telnyx/sms", async (req, res) => {
  const rawBody = (req as unknown as { rawBody?: Buffer }).rawBody;
  if (!rawBody) {
    res.status(200).json({ ok: true, note: "no_raw_body" });
    return;
  }
  const ok = await verifyTelnyxSignature(rawBody, req.headers as Record<string, string | string[] | undefined>);
  if (!ok) {
    logger.warn("telnyx sms webhook signature failed");
    res.status(200).json({ ok: true, note: "unverified" });
    return;
  }

  try {
    await applyTelnyxSmsEvent(req.body);
  } catch (err) {
    logger.error({ err }, "telnyx sms event apply failed");
  }
  res.status(200).json({ ok: true });
});

interface TelnyxSmsWebhookPayload {
  data?: {
    event_type?: string;
    payload?: {
      id?: string;
      to?: Array<{ phone_number?: string; status?: string }>;
      errors?: Array<{ code?: string; detail?: string }>;
    };
  };
}

async function applyTelnyxSmsEvent(body: unknown): Promise<void> {
  const p = (body ?? {}) as TelnyxSmsWebhookPayload;
  const eventType = p.data?.event_type ?? "";
  const messageId = p.data?.payload?.id;
  if (!messageId) return;

  let nextStatus: string | null = null;
  let setDelivered = false;
  let setFailed = false;
  let errorDetail: string | null = null;

  switch (eventType) {
    case "message.sent":
      nextStatus = "sent";
      break;
    case "message.finalized":
      // Telnyx sends a final state in payload.to[].status (delivered / sending_failed / delivery_failed)
      {
        const finalStatus = p.data?.payload?.to?.[0]?.status ?? "";
        if (finalStatus === "delivered") {
          nextStatus = "delivered";
          setDelivered = true;
        } else if (finalStatus === "sending_failed" || finalStatus === "delivery_failed") {
          nextStatus = "failed_delivery";
          setFailed = true;
          errorDetail = p.data?.payload?.errors?.[0]?.detail ?? finalStatus;
        }
      }
      break;
    case "message.failed":
      nextStatus = "failed";
      setFailed = true;
      errorDetail = p.data?.payload?.errors?.[0]?.detail ?? "telnyx_failed";
      break;
    default:
      logger.info({ eventType }, "telnyx sms webhook: unhandled event type");
      return;
  }

  if (!nextStatus) return;

  const updates: Record<string, unknown> = {
    status: nextStatus,
    updated_at: new Date(),
  };
  if (setDelivered) updates.delivered_at = new Date();
  if (setFailed) {
    updates.failed_at = new Date();
    if (errorDetail) updates.error = errorDetail;
  }

  await db
    .update(smsMessagesTable)
    .set(updates)
    .where(eq(smsMessagesTable.telnyx_message_id, messageId));
}

// ─────────────────────────────────────────────────────────────────
// Manual test/trigger endpoint — admin can simulate a "signed" event
// for an envelope by external_envelope_id. Useful when no real provider is wired yet.
// ─────────────────────────────────────────────────────────────────

// Dev-only test endpoint to simulate a signed envelope without a real provider callback.
// HARD-DISABLED in production to prevent unauthenticated state mutation.
router.post("/_test/envelope-signed", async (req, res) => {
  // Block in production AND staging — this endpoint mutates DB state without auth or signature.
  const env = process.env.NODE_ENV;
  if (env === "production" || env === "staging") {
    notFound(res, "not_found");
    return;
  }
  const externalId = req.body?.external_envelope_id;
  if (!externalId) {
    badRequest(res, "external_envelope_id required");
    return;
  }
  await applyEnvelopeEvent("test", {
    externalEnvelopeId: String(externalId),
    status: "signed",
    rawType: "test.signed",
    raw: { triggered_by: "admin_test_endpoint" },
  });
  res.json({ ok: true });
});

export default router;
