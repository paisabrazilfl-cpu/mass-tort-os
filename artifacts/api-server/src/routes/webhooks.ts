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
import { db, documentEnvelopesTable, integrationsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import crypto from "crypto";
import { logger } from "../lib/logger";
import { auditLog } from "../lib/audit";
import { onEnvelopeSigned } from "../lib/workflow-engine";
import { getIntegrationCredentialsById } from "./integrations";
import { badRequest, notFound } from "../lib/http-errors";

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
