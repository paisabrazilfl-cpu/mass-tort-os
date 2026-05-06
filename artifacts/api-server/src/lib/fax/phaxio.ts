import type { FaxAdapter, FaxSendOutcome } from "./types";
import { logger } from "../logger";

/**
 * Phaxio (by Sinch) fax adapter. https://www.phaxio.com/docs/api/v2.1
 * Auth: HTTP Basic with key (api_key) + secret (client_secret).
 */
export const phaxioAdapter: FaxAdapter = {
  provider: "phaxio",

  async send(creds, req): Promise<FaxSendOutcome> {
    const apiKey = creds.api_key?.trim();
    const secret = creds.client_secret?.trim();
    if (!apiKey || !secret) {
      return { ok: false, retryable: false, code: "no_credentials", message: "Phaxio needs api_key + client_secret" };
    }
    if (!req.toNumber) return { ok: false, retryable: false, code: "no_to", message: "Recipient fax missing" };

    const form = new FormData();
    form.append("to", req.toNumber);
    if (req.fromNumber) form.append("caller_id", req.fromNumber);
    form.append("file", new Blob([req.pdf as unknown as ArrayBuffer], { type: "application/pdf" }), req.fileName);

    let resp: Response;
    try {
      resp = await fetch("https://api.phaxio.com/v2.1/faxes", {
        method: "POST",
        headers: { Authorization: `Basic ${Buffer.from(`${apiKey}:${secret}`).toString("base64")}` },
        body: form as any,
      });
    } catch (err) {
      logger.error({ err, provider: "phaxio" }, "phaxio network error");
      return { ok: false, retryable: true, code: "network_error", message: String((err as Error).message) };
    }
    const json: any = await resp.json().catch(() => ({}));
    if (!resp.ok || !json?.data?.id) {
      return {
        ok: false,
        retryable: resp.status === 429 || resp.status >= 500,
        code: `http_${resp.status}`,
        message: json?.message ?? `phaxio: HTTP ${resp.status}`,
        rawResponse: json,
      };
    }
    return { ok: true, externalFaxId: String(json.data.id), rawResponse: json };
  },
};
