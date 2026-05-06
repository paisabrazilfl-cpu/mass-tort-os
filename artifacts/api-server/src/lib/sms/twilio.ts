import type { SmsAdapter, SmsSendOutcome } from "./types";
import { logger } from "../logger";

/**
 * Twilio Programmable Messaging API.
 * https://www.twilio.com/docs/messaging/api
 *
 * Auth: HTTP Basic with Account SID + Auth Token. Vault fields:
 *   account_sid — Twilio Account SID (e.g. ACxxxxx)
 *   api_key     — Twilio Auth Token (or Twilio API Key Secret)
 * Optional config.from_number for the From= field.
 */
export const twilioAdapter: SmsAdapter = {
  provider: "twilio",

  async send(creds, req): Promise<SmsSendOutcome> {
    const accountSid = creds.account_sid?.trim();
    const authToken = creds.api_key?.trim();
    if (!accountSid || !authToken) {
      return { ok: false, retryable: false, code: "no_credentials", message: "Twilio account_sid or api_key missing" };
    }
    const fromNumber = req.from || (creds.config && (creds.config as any).from_number) || null;
    if (!fromNumber) {
      return { ok: false, retryable: false, code: "no_from_number", message: "Twilio requires a from number — set config.from_number" };
    }

    const url = `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(accountSid)}/Messages.json`;
    const params = new URLSearchParams();
    params.set("To", req.to);
    params.set("From", String(fromNumber));
    params.set("Body", req.body);

    let resp: Response;
    try {
      resp = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString("base64")}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: params.toString(),
      });
    } catch (err) {
      logger.error({ err, provider: "twilio" }, "twilio network error");
      return { ok: false, retryable: true, code: "network_error", message: String((err as Error).message) };
    }

    const json: any = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      return {
        ok: false,
        retryable: resp.status === 429 || resp.status >= 500,
        code: `http_${resp.status}`,
        message: json?.message ?? `twilio: HTTP ${resp.status}`,
        rawResponse: json,
      };
    }
    if (!json?.sid) {
      return { ok: false, retryable: false, code: "no_message_sid", message: "twilio returned no message SID", rawResponse: json };
    }
    return { ok: true, externalMessageId: String(json.sid), rawResponse: json };
  },
};
