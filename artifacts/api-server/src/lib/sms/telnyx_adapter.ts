import type { SmsAdapter, SmsSendOutcome } from "./types";
import { logger } from "../logger";

/**
 * Telnyx Messaging API adapter (SmsAdapter wrapper). The underlying
 * sendSms helper in telnyx.ts manages persistence; this adapter is for
 * the provider-router code path that calls SmsAdapter.send directly with
 * pre-resolved credentials.
 */
export const telnyxSmsAdapter: SmsAdapter = {
  provider: "telnyx",

  async send(creds, req): Promise<SmsSendOutcome> {
    const apiKey = creds.api_key?.trim();
    if (!apiKey) {
      return { ok: false, retryable: false, code: "no_api_key", message: "Telnyx api_key missing" };
    }
    const cfg = (creds.config && typeof creds.config === "object" ? creds.config : {}) as Record<string, unknown>;
    const fromNumber =
      req.from ||
      (typeof cfg.from_number === "string" ? cfg.from_number.trim() : "") ||
      null;
    const profileId = typeof cfg.messaging_profile_id === "string" ? cfg.messaging_profile_id.trim() : "";
    if (!fromNumber && !profileId) {
      return {
        ok: false,
        retryable: false,
        code: "no_from",
        message: "Telnyx needs from_number or messaging_profile_id in config",
      };
    }

    const payload: Record<string, unknown> = { to: req.to, text: req.body };
    if (fromNumber) payload.from = fromNumber;
    if (profileId) payload.messaging_profile_id = profileId;

    let resp: Response;
    try {
      resp = await fetch("https://api.telnyx.com/v2/messages", {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
    } catch (err) {
      logger.error({ err, provider: "telnyx" }, "telnyx network error");
      return { ok: false, retryable: true, code: "network_error", message: String((err as Error).message) };
    }
    const json: any = await resp.json().catch(() => ({}));
    if (!resp.ok || !json?.data?.id) {
      return {
        ok: false,
        retryable: resp.status === 429 || resp.status >= 500,
        code: `http_${resp.status}`,
        message: json?.errors?.[0]?.detail ?? `telnyx: HTTP ${resp.status}`,
        rawResponse: json,
      };
    }
    return { ok: true, externalMessageId: String(json.data.id), rawResponse: json };
  },
};
