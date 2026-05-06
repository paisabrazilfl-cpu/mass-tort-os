import type { SmsAdapter, SmsSendOutcome } from "./types";
import { logger } from "../logger";

/**
 * Bird (MessageBird) SMS API.
 * https://docs.bird.com/api/channels-api/supported-channels/sms
 * Auth: AccessKey via Authorization header. Vault: api_key.
 */
export const messagebirdAdapter: SmsAdapter = {
  provider: "messagebird",

  async send(creds, req): Promise<SmsSendOutcome> {
    const apiKey = creds.api_key?.trim();
    if (!apiKey) return { ok: false, retryable: false, code: "no_api_key", message: "MessageBird api_key missing" };
    const fromNumber = req.from || (creds.config as any)?.from_number;
    if (!fromNumber) return { ok: false, retryable: false, code: "no_from_number", message: "MessageBird needs config.from_number" };

    let resp: Response;
    try {
      resp = await fetch("https://rest.messagebird.com/messages", {
        method: "POST",
        headers: { Authorization: `AccessKey ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ originator: String(fromNumber), recipients: [req.to], body: req.body }),
      });
    } catch (err) {
      logger.error({ err, provider: "messagebird" }, "messagebird network error");
      return { ok: false, retryable: true, code: "network_error", message: String((err as Error).message) };
    }
    const json: any = await resp.json().catch(() => ({}));
    if (!resp.ok || !json?.id) {
      return {
        ok: false,
        retryable: resp.status === 429 || resp.status >= 500,
        code: `http_${resp.status}`,
        message: json?.errors?.[0]?.description ?? `messagebird: HTTP ${resp.status}`,
        rawResponse: json,
      };
    }
    return { ok: true, externalMessageId: String(json.id), rawResponse: json };
  },
};
