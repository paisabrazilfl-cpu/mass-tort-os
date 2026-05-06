import type { SmsAdapter, SmsSendOutcome } from "./types";
import { logger } from "../logger";

/**
 * Sinch SMS REST API.
 * https://developers.sinch.com/docs/sms/api-reference/sms/tag/Batches/#tag/Batches/operation/send-sms
 * Auth: Bearer token. Vault: api_key. config.service_plan_id + from_number required.
 */
export const sinchAdapter: SmsAdapter = {
  provider: "sinch",

  async send(creds, req): Promise<SmsSendOutcome> {
    const apiKey = creds.api_key?.trim();
    if (!apiKey) return { ok: false, retryable: false, code: "no_api_key", message: "Sinch api_key missing" };
    const cfg = (creds.config || {}) as Record<string, unknown>;
    const servicePlanId = String(cfg.service_plan_id ?? "").trim();
    const fromNumber = req.from || String(cfg.from_number ?? "").trim();
    const region = String(cfg.region ?? "us").trim() || "us";
    if (!servicePlanId || !fromNumber) {
      return { ok: false, retryable: false, code: "no_config", message: "Sinch needs config.service_plan_id and from_number" };
    }
    const url = `https://${region}.sms.api.sinch.com/xms/v1/${encodeURIComponent(servicePlanId)}/batches`;
    let resp: Response;
    try {
      resp = await fetch(url, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ from: fromNumber, to: [req.to], body: req.body }),
      });
    } catch (err) {
      logger.error({ err, provider: "sinch" }, "sinch network error");
      return { ok: false, retryable: true, code: "network_error", message: String((err as Error).message) };
    }
    const json: any = await resp.json().catch(() => ({}));
    if (!resp.ok || !json?.id) {
      return {
        ok: false,
        retryable: resp.status === 429 || resp.status >= 500,
        code: `http_${resp.status}`,
        message: json?.text ?? `sinch: HTTP ${resp.status}`,
        rawResponse: json,
      };
    }
    return { ok: true, externalMessageId: String(json.id), rawResponse: json };
  },
};
