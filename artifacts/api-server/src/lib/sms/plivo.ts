import type { SmsAdapter, SmsSendOutcome } from "./types";
import { logger } from "../logger";

/**
 * Plivo Messaging API.
 * https://www.plivo.com/docs/sms/api/message
 * Auth: HTTP Basic — Auth ID (account_sid) + Auth Token (api_key).
 */
export const plivoAdapter: SmsAdapter = {
  provider: "plivo",

  async send(creds, req): Promise<SmsSendOutcome> {
    const authId = creds.account_sid?.trim();
    const authToken = creds.api_key?.trim();
    if (!authId || !authToken) {
      return { ok: false, retryable: false, code: "no_credentials", message: "Plivo account_sid or api_key missing" };
    }
    const fromNumber = req.from || (creds.config as any)?.from_number;
    if (!fromNumber) return { ok: false, retryable: false, code: "no_from_number", message: "Plivo needs config.from_number" };

    const url = `https://api.plivo.com/v1/Account/${encodeURIComponent(authId)}/Message/`;
    let resp: Response;
    try {
      resp = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Basic ${Buffer.from(`${authId}:${authToken}`).toString("base64")}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ src: String(fromNumber), dst: req.to, text: req.body }),
      });
    } catch (err) {
      logger.error({ err, provider: "plivo" }, "plivo network error");
      return { ok: false, retryable: true, code: "network_error", message: String((err as Error).message) };
    }
    const json: any = await resp.json().catch(() => ({}));
    if (!resp.ok || !json?.message_uuid?.[0]) {
      return {
        ok: false,
        retryable: resp.status === 429 || resp.status >= 500,
        code: `http_${resp.status}`,
        message: json?.error ?? `plivo: HTTP ${resp.status}`,
        rawResponse: json,
      };
    }
    return { ok: true, externalMessageId: String(json.message_uuid[0]), rawResponse: json };
  },
};
