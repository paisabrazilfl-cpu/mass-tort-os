import type { SmsAdapter, SmsSendOutcome } from "./types";
import { logger } from "../logger";

/**
 * Bandwidth Messaging API v2.
 * https://dev.bandwidth.com/apis/messaging
 * Auth: HTTP Basic — vault api_key holds the API token (username:password
 * encoded as "user:secret"). config.account_id and config.application_id
 * carry the non-secret IDs.
 */
export const bandwidthAdapter: SmsAdapter = {
  provider: "bandwidth",

  async send(creds, req): Promise<SmsSendOutcome> {
    const apiKey = creds.api_key?.trim();
    if (!apiKey || !apiKey.includes(":")) {
      return { ok: false, retryable: false, code: "no_credentials", message: "Bandwidth api_key must be 'user:secret'" };
    }
    const cfg = (creds.config || {}) as Record<string, unknown>;
    const accountId = String(cfg.account_id ?? "").trim();
    const applicationId = String(cfg.application_id ?? "").trim();
    const fromNumber = req.from || String(cfg.from_number ?? "").trim();
    if (!accountId || !applicationId || !fromNumber) {
      return { ok: false, retryable: false, code: "no_config", message: "Bandwidth needs config.account_id, application_id, from_number" };
    }
    const url = `https://messaging.bandwidth.com/api/v2/users/${encodeURIComponent(accountId)}/messages`;

    let resp: Response;
    try {
      resp = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Basic ${Buffer.from(apiKey).toString("base64")}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          applicationId,
          to: [req.to],
          from: fromNumber,
          text: req.body,
        }),
      });
    } catch (err) {
      logger.error({ err, provider: "bandwidth" }, "bandwidth network error");
      return { ok: false, retryable: true, code: "network_error", message: String((err as Error).message) };
    }
    const json: any = await resp.json().catch(() => ({}));
    if (!resp.ok || !json?.id) {
      return {
        ok: false,
        retryable: resp.status === 429 || resp.status >= 500,
        code: `http_${resp.status}`,
        message: json?.description ?? `bandwidth: HTTP ${resp.status}`,
        rawResponse: json,
      };
    }
    return { ok: true, externalMessageId: String(json.id), rawResponse: json };
  },
};
