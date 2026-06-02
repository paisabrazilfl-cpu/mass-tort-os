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
  leadsTable,
  smsMessagesTable,
  leadDispositionsTable,
  emailEventsTable,
  emailMessagesTable,
  faxEventsTable,
} from "@workspace/db";
import { eq, sql, or } from "drizzle-orm";
import crypto from "crypto";
import { logger } from "../lib/logger";
import { auditLog } from "../lib/audit";
import { onEnvelopeSigned } from "../lib/workflow-engine";
import { getIntegrationCredentialsById } from "./integrations";
import { badRequest, notFound } from "../lib/http-errors";
import { verifyWebhook as verifyStripeWebhook } from "../lib/payments/stripe";
import { verifyVapiSignature } from "../lib/voice/vapi-webhook";
import { resolveInboundTort } from "../lib/voice/inbound-routing";
import { encryptLeadFields, rebindLeadEncryptionAad } from "../lib/encryption";
import { leadLookupHash } from "../lib/lead-lookup-hash";
import { findExistingLeadForIntake } from "../lib/lead-dedup";
import { verifyTelnyxSignature } from "../lib/sms/telnyx";
import { verifyFastenSignature } from "../lib/fasten/webhook";
import { getFastenWebhookSecret } from "../lib/fasten/client";
import { fastenConnectionsTable } from "@workspace/db";
import { enqueueJob } from "../lib/queue";
import { dispatchTrigger } from "../lib/automations/dispatch";
import { getEmailVerifier, getSmsVerifier, type VerifyContext, type SignatureStatus } from "../lib/webhook-verifiers";
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
    // Dispatch internal automation trigger for trigger.document_signed workflows.
    void dispatchTrigger("trigger.document_signed", {
      input: {
        envelope_id: env.id,
        lead_id: env.lead_id ?? null,
        external_envelope_id: evt.externalEnvelopeId,
        provider,
      },
      firmId: (env as unknown as { firm_id?: number | null }).firm_id ?? null,
      source: `webhook:${provider}`,
    });
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
//
// Per spec (Task #51 T003) we expose ONE multiplexer route plus FIVE thin
// named-event routes. The named routes let Vapi dashboards point individual
// event hooks at distinct URLs (some operators prefer that), while the
// multiplexer keeps backwards-compatibility with deployments that pin a
// single webhook URL and discriminate on the JSON `type` field. All routes
// re-use the same signature verifier and applyVapiEvent dispatcher so the
// per-event side effects (call_logs upsert, lead_dispositions, review_queue
// escalation, etc.) live in exactly one place.
// ─────────────────────────────────────────────────────────────────

async function handleVapiWebhook(
  req: import("express").Request,
  res: import("express").Response,
  forcedEventType: string | null,
): Promise<void> {
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
    // Named routes pin the event type so a payload that arrived at e.g.
    // /webhooks/vapi/call-ended is always treated as call-ended even if the
    // body's `type` field disagrees. The multiplexer leaves it to the body.
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (forcedEventType) {
      body["type"] = forcedEventType;
    }
    await applyVapiEvent(body);
  } catch (err) {
    logger.error({ err }, "vapi event apply failed");
  }
  res.status(200).json({ ok: true });
}

router.post("/vapi", (req, res) => handleVapiWebhook(req, res, null));
router.post("/vapi/call-started", (req, res) => handleVapiWebhook(req, res, "call-started"));
router.post("/vapi/transcript", (req, res) => handleVapiWebhook(req, res, "transcript"));
router.post("/vapi/call-ended", (req, res) => handleVapiWebhook(req, res, "call-ended"));
router.post("/vapi/intake-result", (req, res) => handleVapiWebhook(req, res, "intake-result"));
router.post("/vapi/escalate-human", (req, res) => handleVapiWebhook(req, res, "escalate-human"));

interface VapiEventPayload {
  type?: string;
  call?: {
    id?: string;
    status?: string;
    customer?: { number?: string };
    assistant?: { id?: string };
    // The dialed (destination) number — our dedicated per-tort number the
    // caller rang. Vapi nests it under `phoneNumber.number` and also exposes
    // a `phoneNumberId`. Either lets us resolve which tort/form to run.
    phoneNumber?: { id?: string; number?: string };
    phoneNumberId?: string;
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

/**
 * Normalize a phone to E.164 (US-centric) so inbound leads share the same
 * shape as every other intake surface.
 */
function normalizeInboundPhone(raw: string): string {
  const digits = raw.replace(/\D+/g, "");
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length > 0) return `+${digits}`;
  return "";
}

/**
 * Find (via the shared dedup pipeline) or create a minimal lead for an
 * inbound call so the agent has a real row to progressively fill. The lead
 * starts with just the tort + caller phone; the rest is captured live via
 * the update-lead tool. Returns the lead id, or null when the phone is
 * unusable.
 */
async function findOrCreateInboundLead(input: {
  tortType: string;
  phone: string;
  firmId: number | null;
}): Promise<number | null> {
  const phoneE164 = normalizeInboundPhone(input.phone);
  if (!phoneE164) return null;

  const existing = await findExistingLeadForIntake({
    tortType: input.tortType,
    phone: phoneE164,
    firmId: input.firmId,
  });
  if (existing) return existing.leadId;

  // lookup_hash needs the full (tort|email|phone) triple; with no email yet
  // it stays null and is backfilled later by update-lead once email lands.
  const encrypted = encryptLeadFields({
    name: `Vapi caller ${phoneE164}`,
    phone: phoneE164,
  });
  const [inserted] = await db
    .insert(leadsTable)
    .values({
      tort_type: input.tortType,
      firm_id: input.firmId,
      source: "vapi_inbound",
      status: "new",
      ...(encrypted as Pick<typeof leadsTable.$inferInsert, "name" | "phone">),
    })
    .returning();
  await rebindLeadEncryptionAad(db, leadsTable, inserted!, eq);
  return inserted!.id;
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
    const metadataFirmId = Number.isFinite(firmId) && firmId > 0 ? firmId : null;
    const callerNumber = call?.customer?.number ?? null;
    const dialedNumber = call?.phoneNumber?.number ?? null;

    // Inbound calls land on a dedicated per-tort number. Resolve which
    // tort/form to run (metadata → assistant → dialed number) so the call
    // is attributed correctly and a lead can be started for progressive
    // capture even when the Vapi assistant metadata is absent.
    let tortType: string | null =
      typeof call?.metadata?.tort_id === "string" ? (call.metadata.tort_id as string) : null;
    let resolvedFirmId = metadataFirmId;
    let resolvedLeadId = Number.isFinite(leadId) && leadId > 0 ? leadId : null;
    try {
      const routing = await resolveInboundTort({
        metadataTortId: tortType,
        assistantId: call?.assistant?.id ?? null,
        dialedNumber,
        dialedNumberId: call?.phoneNumber?.id ?? call?.phoneNumberId ?? null,
      });
      tortType = routing.tortId;
      // The dialed number is the authoritative tenancy signal for inbound:
      // prefer the firm explicitly set on the call metadata, otherwise adopt
      // the firm that owns the number. This scopes dedup so a caller is never
      // attached to a different firm's lead.
      if (resolvedFirmId == null) resolvedFirmId = routing.firmId;
    } catch (err) {
      logger.warn({ err, vapiCallId }, "vapi inbound: tort resolution failed");
    }

    // Start the lead now so each answer the agent saves mid-call lands on a
    // real row (form fills as the call goes). Dedup first so we attach to an
    // existing lead instead of creating a duplicate.
    if (resolvedLeadId === null && tortType && callerNumber) {
      try {
        resolvedLeadId = await findOrCreateInboundLead({
          tortType,
          phone: callerNumber,
          firmId: resolvedFirmId,
        });
      } catch (err) {
        logger.warn({ err, vapiCallId, tortType }, "vapi inbound: find-or-create lead failed");
      }
    }

    const [inserted] = await db
      .insert(callLogsTable)
      .values({
        firm_id: resolvedFirmId,
        lead_id: resolvedLeadId,
        vapi_call_id: vapiCallId,
        vapi_assistant_id: call?.assistant?.id ?? null,
        tort_type: tortType,
        direction: "inbound",
        from_number: callerNumber,
        to_number: dialedNumber,
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
      // Dispatch trigger.inbound_call to any enabled automation workflows.
      void dispatchTrigger("trigger.inbound_call", {
        input: {
          call_id: row.id,
          vapi_call_id: vapiCallId,
          lead_id: row.lead_id ?? null,
          duration,
        },
        firmId: row.firm_id ?? null,
        source: "vapi_webhook",
      });
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
    case "message.received": {
      // Inbound SMS — dispatch trigger but do not update outbound sms_messages table.
      // Cast to a wider type because TelnyxSmsWebhookPayload models outbound-only fields.
      type InboundPl = { from?: { phone_number?: string }; text?: string; to?: Array<{ phone_number?: string }> };
      const inboundPl = p.data?.payload as unknown as InboundPl | undefined;
      void dispatchTrigger("trigger.inbound_sms", {
        input: {
          message_id: messageId,
          from: inboundPl?.from?.phone_number ?? null,
          body: inboundPl?.text ?? null,
          to: inboundPl?.to?.[0]?.phone_number ?? null,
        },
        firmId: null,
        source: "telnyx_webhook",
      });
      return;
    }
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

// ─────────────────────────────────────────────────────────────────
// Generic provider-event webhook ingest for Email / SMS / Fax / Voice.
//
// Each ingest endpoint:
//   - Resolves the active integration row for the provider.
//   - Verifies the signature when the provider documents a well-known
//     scheme we have implemented; otherwise records signature_status
//     as "unverified" so operators can audit.
//   - Persists a row to email_events / fax_events / sms_messages so
//     downstream automation can react. Always 200s the provider.
//
// Detailed signature-verification handlers continue to live above
// (Stripe, Dropbox Sign, DocuSign, Vapi, Telnyx SMS). The generic
// handlers below are intentionally permissive so operators can
// onboard a provider quickly even if signing isn't configured yet.
// ─────────────────────────────────────────────────────────────────

const EMAIL_EVENT_PROVIDERS = new Set(["sendgrid", "postmark", "resend", "mailgun", "aws_ses", "brevo"]);
const FAX_EVENT_PROVIDERS = new Set(["srfax", "efax", "phaxio", "documo", "telnyx_fax"]);
const SMS_EVENT_PROVIDERS = new Set(["bandwidth", "plivo", "messagebird", "sinch"]);
const VOICE_EVENT_PROVIDERS = new Set(["retell_ai", "bland_ai", "elevenlabs", "synthflow"]);

type AnyJson = Record<string, unknown>;

/**
 * Map a provider Event-Webhook event type onto the canonical
 * email_messages.status + the timestamp column to stamp. Covers SendGrid
 * (delivered/bounce/dropped/spamreport/deferred/processed) and the
 * common variants used by Postmark/Mailgun/Resend so the same receiver
 * advances every provider's outbound row. Returns null for events that
 * should not change delivery state (open/click/unsubscribe/…).
 */
function normalizeEmailMessageStatus(
  rawType: string | undefined,
): { status: string; tsField?: "delivered_at" | "bounced_at" | "failed_at" | "sent_at" } | null {
  const s = rawType?.toLowerCase();
  if (!s) return null;
  if (["delivered", "delivery"].includes(s)) return { status: "delivered", tsField: "delivered_at" };
  if (["bounce", "bounced", "blocked", "hardbounce", "softbounce"].includes(s)) {
    return { status: "bounced", tsField: "bounced_at" };
  }
  if (["dropped"].includes(s)) return { status: "dropped", tsField: "failed_at" };
  if (["spamreport", "spamcomplaint", "complaint"].includes(s)) {
    return { status: "spamreport", tsField: "failed_at" };
  }
  if (["deferred"].includes(s)) return { status: "deferred" };
  if (["processed", "sent"].includes(s)) return { status: "sent", tsField: "sent_at" };
  return null;
}

function looksJsonObject(v: unknown): v is AnyJson {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function pickFirstString(o: AnyJson | undefined, keys: string[]): string | undefined {
  if (!o) return undefined;
  for (const k of keys) {
    const v = o[k];
    if (typeof v === "string" && v.length > 0) return v;
  }
  return undefined;
}

/** Build a VerifyContext from the express request. Uses captured rawBody. */
function buildVerifyCtx(req: import("express").Request): VerifyContext {
  const proto = (req.headers["x-forwarded-proto"] as string) || req.protocol;
  const host = (req.headers["x-forwarded-host"] as string) || req.headers.host || "";
  const fullUrl = `${proto}://${host}${req.originalUrl}`;
  const rawBody = (req as unknown as { rawBody?: Buffer }).rawBody ?? Buffer.from("");
  // Form-encoded bodies (Twilio) — express.urlencoded() populates req.body as object.
  const formBody = (req.is("application/x-www-form-urlencoded") && looksJsonObject(req.body))
    ? Object.fromEntries(Object.entries(req.body).map(([k, v]) => [k, String(v)]))
    : undefined;
  return { rawBody, headers: req.headers, fullUrl, formBody };
}

/**
 * Resolve the active integration row for a provider, load its
 * decrypted credentials, and return the integration_id alongside.
 * Both can be null when the operator hasn't onboarded the provider —
 * the webhook still 200s but signature_status falls through to
 * "unverified".
 */
async function loadProviderForWebhook(provider: string): Promise<{
  integrationId: number | null;
  creds: import("./integrations").DecryptedCredentials | null;
}> {
  const rows = await db
    .select({ id: integrationsTable.id, status: integrationsTable.status })
    .from(integrationsTable)
    .where(eq(integrationsTable.provider, provider));
  const active = rows.find((r) => r.status === "active");
  if (!active) return { integrationId: null, creds: null };
  const creds = await getIntegrationCredentialsById(active.id);
  return { integrationId: active.id, creds };
}

router.post("/email/:provider", async (req, res) => {
  const provider = String(req.params.provider || "").toLowerCase();
  if (!EMAIL_EVENT_PROVIDERS.has(provider)) {
    notFound(res, "unknown_email_provider");
    return;
  }
  const events: AnyJson[] = Array.isArray(req.body)
    ? (req.body as AnyJson[])
    : looksJsonObject(req.body)
    ? [req.body]
    : [];

  const { integrationId, creds } = await loadProviderForWebhook(provider);

  // Verify ONCE per request — provider sigs cover the whole rawBody.
  const verifier = getEmailVerifier(provider);
  let signatureStatus: SignatureStatus = "unverified";
  if (verifier) signatureStatus = verifier(buildVerifyCtx(req), creds);
  if (signatureStatus === "invalid") {
    logger.warn({ provider }, "email webhook signature INVALID — persisting event flagged");
    await auditLog("email_webhook_invalid_signature", provider, String(integrationId ?? "none"), {
      header_keys: Object.keys(req.headers),
    });
  }

  for (const evt of events) {
    const externalId = pickFirstString(evt, ["MessageID", "messageId", "message_id", "id", "sg_message_id"]);
    const eventType = pickFirstString(evt, ["RecordType", "event", "type", "EventType"]) ?? "unknown";
    const recipient = pickFirstString(evt, ["Recipient", "recipient", "email", "To"]);

    // Correlate to the outbound email_messages row we logged at send time
    // so (a) the lead detail view shows delivered/bounced and (b) the
    // event row is back-linked to the firm/lead it belongs to. SendGrid's
    // event `sg_message_id` is `<X-Message-Id>.<suffix>`, so match the
    // exact id OR the prefix before the first ".".
    let outboundFirmId: number | null = null;
    let outboundLeadId: number | null = null;
    let outboundRow: { id: number; firm_id: number | null; lead_id: number | null } | null = null;
    if (externalId) {
      const prefix = externalId.split(".")[0]!;
      const [match] = await db
        .select({ id: emailMessagesTable.id, firm_id: emailMessagesTable.firm_id, lead_id: emailMessagesTable.lead_id })
        .from(emailMessagesTable)
        .where(
          or(
            eq(emailMessagesTable.external_message_id, externalId),
            eq(emailMessagesTable.external_message_id, prefix),
          ),
        )
        .limit(1);
      if (match) {
        outboundRow = match;
        outboundFirmId = match.firm_id ?? null;
        outboundLeadId = match.lead_id ?? null;
      }
    }

    try {
      await db.insert(emailEventsTable).values({
        integration_id: integrationId,
        firm_id: outboundFirmId,
        lead_id: outboundLeadId,
        provider,
        external_message_id: externalId,
        event_type: eventType.slice(0, 64),
        recipient_email: recipient?.slice(0, 320),
        signature_status: signatureStatus,
        raw_payload: evt,
      });
    } catch (err) {
      logger.warn({ err, provider }, "email_events insert failed");
    }

    // SECURITY: only mutate the outbound delivery state when the
    // provider's signature actually verified. "unverified" means we lack
    // the signing key (SendGrid client_secret) or the header is missing;
    // either way, persisting would let an unauthenticated caller falsify
    // delivery status. The event row above is still recorded for audit.
    if (outboundRow && signatureStatus === "verified") {
      const mapped = normalizeEmailMessageStatus(eventType);
      if (mapped) {
        try {
          const set: Record<string, unknown> = { status: mapped.status, updated_at: new Date() };
          if (mapped.tsField) set[mapped.tsField] = new Date();
          await db.update(emailMessagesTable).set(set).where(eq(emailMessagesTable.id, outboundRow.id));
        } catch (err) {
          logger.warn({ err, provider, externalId }, "email_messages status update failed");
        }
      }
    }
  }
  res.json({ ok: true, received: events.length, signature_status: signatureStatus });
});

router.post("/fax/:provider", async (req, res) => {
  const provider = String(req.params.provider || "").toLowerCase();
  if (!FAX_EVENT_PROVIDERS.has(provider)) {
    notFound(res, "unknown_fax_provider");
    return;
  }
  const evt: AnyJson = looksJsonObject(req.body) ? req.body : { body: req.body };

  const { integrationId } = await loadProviderForWebhook(provider);
  // No documented common signature schemes for srfax/efax/phaxio/documo/telnyx_fax
  // (Telnyx Fax uses the same Ed25519 scheme as its SMS API but the v2 raw fax
  // webhook is opt-in and rarely configured). Mark unverified.
  const signatureStatus: SignatureStatus = "unverified";

  const externalId =
    pickFirstString(evt, ["faxId", "id", "fax_id", "FaxID"]) ??
    pickFirstString((evt as { data?: AnyJson }).data, ["id", "fax_id"]);
  const eventType =
    pickFirstString(evt, ["event", "EventType", "type"]) ??
    pickFirstString((evt as { data?: AnyJson }).data, ["event_type"]) ??
    "unknown";
  const status =
    pickFirstString(evt, ["status", "Status"]) ??
    pickFirstString((evt as { data?: AnyJson }).data, ["status"]);
  const pages = (() => {
    const data = (evt as { data?: AnyJson; pages?: unknown; Pages?: unknown });
    const v = data.pages ?? data.Pages ?? (data.data && (data.data as AnyJson).pages);
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  })();

  try {
    await db.insert(faxEventsTable).values({
      integration_id: integrationId,
      firm_id: null,   // fax correlation requires an outbound fax_messages table; not yet shipped
      lead_id: null,
      provider,
      external_fax_id: externalId,
      event_type: eventType.slice(0, 64),
      status: status?.slice(0, 64),
      pages,
      signature_status: signatureStatus,
      raw_payload: evt,
    });
  } catch (err) {
    logger.warn({ err, provider }, "fax_events insert failed");
  }
  res.json({ ok: true, signature_status: signatureStatus });
});

router.post("/sms/:provider", async (req, res) => {
  const provider = String(req.params.provider || "").toLowerCase();
  // twilio is allowed here so its signature scheme is enforced via the
  // shared verifier registry; bandwidth/plivo/messagebird/sinch are
  // the new providers without dedicated handlers above.
  const allowed = new Set([...SMS_EVENT_PROVIDERS, "twilio"]);
  if (!allowed.has(provider)) {
    notFound(res, "unknown_sms_provider");
    return;
  }
  const evt: AnyJson = looksJsonObject(req.body) ? req.body : { body: req.body };

  const { integrationId, creds } = await loadProviderForWebhook(provider);
  const verifier = getSmsVerifier(provider);
  let signatureStatus: SignatureStatus = "unverified";
  if (verifier) signatureStatus = verifier(buildVerifyCtx(req), creds);
  if (signatureStatus === "invalid") {
    logger.warn({ provider }, "sms webhook signature INVALID — refusing to mutate sms_messages");
    await auditLog("sms_webhook_invalid_signature", provider, String(integrationId ?? "none"), {});
    res.json({ ok: true, signature_status: "invalid" });
    return;
  }

  // Correlate inbound delivery report → sms_messages row by external id
  // so the persisted update lights up the lead history view.
  const externalId = pickFirstString(evt, [
    "MessageSid", "message_id", "id", "messageId", "MessageUUID",
  ]);
  const rawStatus = pickFirstString(evt, [
    "MessageStatus", "status", "EventType", "Status",
  ]);
  // Normalize provider-specific status verbiage onto sms_messages.status.
  const status = (() => {
    const s = rawStatus?.toLowerCase();
    if (!s) return null;
    if (["delivered", "received"].includes(s)) return "delivered";
    if (["failed", "undelivered", "rejected"].includes(s)) return "failed";
    if (["sent", "queued", "accepted"].includes(s)) return s;
    return s.slice(0, 30);
  })();

  // SECURITY: only mutate sms_messages when the signature was actually
  // verified. "unverified" means we either lack the secret or the header
  // is missing; either way, persisting would let an unauthenticated
  // caller falsify delivery state. We still 200 so providers don't
  // disable the endpoint, but the row stays untouched.
  if (externalId && status && signatureStatus === "verified") {
    try {
      const setBase: Record<string, unknown> = { status, updated_at: new Date() };
      if (status === "delivered") setBase.delivered_at = new Date();
      if (status === "failed") setBase.failed_at = new Date();

      if (provider === "telnyx") {
        // Backwards-compat path — Telnyx still uses the dedicated column.
        await db
          .update(smsMessagesTable)
          .set(setBase)
          .where(eq(smsMessagesTable.telnyx_message_id, externalId));
      } else {
        await db
          .update(smsMessagesTable)
          .set(setBase)
          .where(eq(smsMessagesTable.external_message_id, externalId));
      }
    } catch (err) {
      logger.warn({ err, provider, externalId }, "sms_messages status update failed");
    }
  }

  await auditLog("sms_provider_webhook", provider, "received", {
    signature_status: signatureStatus,
    external_id: externalId ?? null,
    status: status ?? null,
  });
  res.json({ ok: true, signature_status: signatureStatus });
});

/**
 * Per-provider voice webhook → call_logs persistence.
 *
 * Each provider names its outbound-call id and event-type fields
 * differently. We pluck the common ones, normalize the status, and
 * upsert the call_logs row (matched by vapi_call_id when provider
 * === "vapi", otherwise stored in events[]). For ringing/end events
 * we also patch started_at / ended_at / duration_seconds when the
 * provider includes them.
 */
function pickVoiceExternalId(provider: string, evt: AnyJson): string | undefined {
  if (provider === "retell_ai") return pickFirstString(evt, ["call_id"]) ?? pickFirstString((evt as { call?: AnyJson }).call, ["call_id"]);
  if (provider === "bland_ai") return pickFirstString(evt, ["call_id", "c_id"]);
  if (provider === "elevenlabs") return pickFirstString(evt, ["conversation_id", "callSid"]);
  if (provider === "synthflow") return pickFirstString(evt, ["call_id"]) ?? pickFirstString((evt as { response?: AnyJson }).response, ["call_id"]);
  return pickFirstString(evt, ["call_id", "id"]);
}

function normalizeVoiceStatus(raw: string | undefined): string {
  if (!raw) return "unknown";
  const s = raw.toLowerCase();
  if (["call-started", "call_started", "ringing", "started", "in-progress", "ongoing"].includes(s)) return "ringing";
  if (["call-ended", "call_ended", "ended", "completed", "hangup"].includes(s)) return "completed";
  if (["failed", "no-answer", "busy", "rejected"].includes(s)) return "failed";
  return s.slice(0, 30);
}

router.post("/voice/:provider", async (req, res) => {
  const provider = String(req.params.provider || "").toLowerCase();
  if (!VOICE_EVENT_PROVIDERS.has(provider)) {
    notFound(res, "unknown_voice_provider");
    return;
  }
  const evt: AnyJson = looksJsonObject(req.body) ? req.body : { body: req.body };

  // Voice providers (retell/bland/elevenlabs/synthflow) use webhook
  // secrets that vary by provider. When a credentials vault row carries
  // a `client_secret` (HMAC key), verify against the standard
  // `x-<provider>-signature` header (HMAC-SHA256 over rawBody). Anything
  // we cannot verify falls back to "unverified" and is blocked from
  // persisting below.
  const { creds: voiceCreds } = await loadProviderForWebhook(provider);
  let signatureStatus: SignatureStatus = "unverified";
  const voiceSecret = typeof voiceCreds?.client_secret === "string" ? voiceCreds.client_secret : null;
  const voiceSig =
    (req.get(`x-${provider.replace(/_/g, "-")}-signature`) ??
      req.get("x-webhook-signature") ??
      "").trim();
  if (voiceSecret && voiceSig) {
    try {
      // Use the captured rawBody buffer (express.json verify hook in
      // app.ts attaches `rawBody` to the request) — re-stringifying
      // req.body would yield different bytes than the provider signed,
      // and produce a false-invalid HMAC. Fall through to "invalid"
      // when rawBody is absent so we never silently accept.
      const rawBody = (req as unknown as { rawBody?: Buffer }).rawBody;
      if (!rawBody || rawBody.length === 0) {
        signatureStatus = "invalid";
      } else {
        const expected = crypto.createHmac("sha256", voiceSecret).update(rawBody).digest("hex");
        const a = Buffer.from(expected, "utf8");
        const b = Buffer.from(voiceSig, "utf8");
        signatureStatus = a.length === b.length && crypto.timingSafeEqual(a, b) ? "verified" : "invalid";
      }
    } catch {
      signatureStatus = "invalid";
    }
  }
  if (signatureStatus === "invalid") {
    logger.warn({ provider }, "voice webhook signature INVALID — refusing to mutate call_logs");
    await auditLog("voice_webhook_invalid_signature", provider, "received", {});
    res.json({ ok: true, signature_status: "invalid" });
    return;
  }

  const externalId = pickVoiceExternalId(provider, evt);
  const eventKind = pickFirstString(evt, ["event", "type", "EventType", "kind"]);
  const status = normalizeVoiceStatus(eventKind ?? pickFirstString(evt, ["status"]));
  const durationSec = (() => {
    const v = (evt as { duration_seconds?: unknown; duration?: unknown; call_length?: unknown });
    const n = Number(v.duration_seconds ?? v.duration ?? v.call_length);
    return Number.isFinite(n) && n >= 0 ? Math.round(n) : null;
  })();
  const recordingUrl = pickFirstString(evt, ["recording_url", "recordingUrl", "audio_url"]);

  // SECURITY: only persist call_logs mutations when the request was
  // actually verified. Unverified events are audit-only.
  if (externalId && signatureStatus === "verified") {
    try {
      // Match by provider-specific column for vapi (existing path),
      // otherwise scan recent outbound rows whose events log carries
      // this external id from the /api/calls/outbound dispatcher.
      const matchedRows = provider === "vapi"
        ? await db.select({ id: callLogsTable.id }).from(callLogsTable).where(eq(callLogsTable.vapi_call_id, externalId)).limit(1)
        : await db
            .select({ id: callLogsTable.id })
            .from(callLogsTable)
            .where(sql`${callLogsTable.events} @> ${JSON.stringify([{ external_call_id: externalId }])}::jsonb`)
            .limit(1);

      if (matchedRows[0]) {
        const updates: Record<string, unknown> = {
          status,
          updated_at: new Date(),
          events: sql`${callLogsTable.events} || ${JSON.stringify([
            { kind: eventKind ?? "event", provider, ts: new Date().toISOString(), payload: evt },
          ])}::jsonb`,
        };
        if (status === "ringing") updates.started_at = new Date();
        if (status === "completed" || status === "failed") updates.ended_at = new Date();
        if (durationSec !== null) updates.duration_seconds = durationSec;
        if (recordingUrl) updates.recording_url = recordingUrl;
        await db.update(callLogsTable).set(updates).where(eq(callLogsTable.id, matchedRows[0].id));
      } else {
        // No prior row — likely a provider-initiated inbound call. Insert
        // a fresh row so the operator can still see it land.
        await db.insert(callLogsTable).values({
          direction: "inbound",
          status,
          to_number: pickFirstString(evt, ["to", "to_number", "called_number"]),
          from_number: pickFirstString(evt, ["from", "from_number", "caller"]),
          vapi_call_id: provider === "vapi" ? externalId : null,
          events: [{ kind: eventKind ?? "event", provider, external_call_id: externalId, ts: new Date().toISOString(), payload: evt }],
          recording_url: recordingUrl ?? null,
          duration_seconds: durationSec ?? null,
        });
      }
    } catch (err) {
      logger.warn({ err, provider, externalId }, "call_logs persistence failed");
    }
  }

  await auditLog("voice_provider_webhook", provider, "received", {
    signature_status: signatureStatus,
    external_call_id: externalId ?? null,
    status,
  });
  res.json({ ok: true, signature_status: signatureStatus });
});

// ─────────────────────────────────────────────────────────────────
// Fasten Health webhook
//   Auth: HMAC-SHA256 of `${timestamp}.${rawBody}` using the webhook
//   signing secret stored on the fasten_connect integration row as
//   `client_secret`. Header: `Fasten-Signature: t=<unix>,v1=<hex>`.
//   Replay window: 5 minutes.
//
//   On `connection.completed` we mark the matching pending row "active"
//   and enqueue the first records sync. On `connection.disconnected`
//   we mark the row "revoked". Other events are recorded for audit.
// ─────────────────────────────────────────────────────────────────

router.post("/fasten", async (req, res) => {
  try {
    const rawBody = (req as unknown as { rawBody?: Buffer }).rawBody;
    const header = req.header("fasten-signature") || req.header("Fasten-Signature") || "";
    const secret = await getFastenWebhookSecret();
    const sigStatus = verifyFastenSignature({ rawBody, header, secret });

    if (sigStatus !== "ok") {
      logger.warn({ provider: "fasten", sigStatus }, "Fasten webhook signature check failed — refusing state mutation");
      res.status(200).json({ ok: true, note: sigStatus });
      return;
    }

    const evt = (req.body || {}) as {
      type?: string;
      data?: { org_connection_id?: string; external_id?: string; status?: string };
    };
    const orgConnectionId = evt.data?.org_connection_id;
    const externalId = evt.data?.external_id;
    if (!orgConnectionId && !externalId) {
      logger.info({ provider: "fasten", type: evt.type }, "Fasten webhook with no correlation id — ack only");
      res.status(200).json({ ok: true });
      return;
    }

    // Locate the pending connection row by external_id (carried in metadata)
    // or by an already-known org_connection_id.
    const rows = await db.select().from(fastenConnectionsTable);
    const conn = rows.find((r) => {
      if (orgConnectionId && r.org_connection_id === orgConnectionId) return true;
      const meta = (r.metadata as { external_id?: string } | null) || null;
      return externalId && meta?.external_id === externalId;
    });
    if (!conn) {
      logger.warn({ provider: "fasten", orgConnectionId, externalId }, "Fasten webhook for unknown connection — ignoring");
      res.status(200).json({ ok: true });
      return;
    }

    const update: Record<string, unknown> = { updated_at: new Date() };
    if (orgConnectionId && !conn.org_connection_id) update.org_connection_id = orgConnectionId;

    if (evt.type === "connection.completed" || evt.data?.status === "active") {
      update.status = "active";
    } else if (evt.type === "connection.disconnected" || evt.data?.status === "revoked") {
      update.status = "revoked";
    } else if (evt.type === "connection.reauth_required" || evt.data?.status === "reauth") {
      update.status = "reauth";
    }

    await db
      .update(fastenConnectionsTable)
      .set(update)
      .where(eq(fastenConnectionsTable.id, conn.id));

    await auditLog("fasten_connection", String(conn.id), `webhook_${evt.type ?? "event"}`, {
      org_connection_id: orgConnectionId,
      external_id: externalId,
    });

    if (update.status === "active") {
      try {
        await enqueueJob("fasten_records_sync", {
          connection_id: conn.id,
          lead_id: conn.lead_id,
          case_id: `lead-${conn.lead_id}`,
          backend: conn.backend as "connect" | "onprem",
          org_connection_id: (orgConnectionId || conn.org_connection_id) as string,
        });
      } catch (err) {
        logger.warn({ err, connectionId: conn.id }, "Auto-enqueue of fasten sync from webhook failed");
      }
    }

    res.status(200).json({ ok: true });
  } catch (err) {
    logger.error({ err }, "Fasten webhook handler error");
    res.status(200).json({ ok: true, note: "handler_error_logged" });
  }
});

export default router;
