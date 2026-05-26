import type { FaxAdapter, FaxSendOutcome } from "./types";
import { logger } from "../logger";

function normalizeDocumoStatus(s: string): string {
  const lower = s.toLowerCase();
  if (lower === "success" || lower === "sent" || lower === "delivered") return "delivered";
  if (lower === "failed" || lower === "error" || lower === "cancelled") return "failed";
  return "pending";
}

/**
 * Documo (mFax) fax adapter. https://docs.documo.com
 * Auth: Bearer api_key.
 */
export const documoAdapter: FaxAdapter = {
  provider: "documo",

  async send(creds, req): Promise<FaxSendOutcome> {
    const apiKey = creds.api_key?.trim();
    if (!apiKey) return { ok: false, retryable: false, code: "no_api_key", message: "Documo api_key missing" };
    if (!req.toNumber) return { ok: false, retryable: false, code: "no_to", message: "Recipient fax missing" };

    const form = new FormData();
    form.append("faxNumber", req.toNumber);
    form.append("attachments", new Blob([req.pdf as unknown as ArrayBuffer], { type: "application/pdf" }), req.fileName);
    if (req.fromNumber) form.append("callerId", req.fromNumber);

    let resp: Response;
    try {
      resp = await fetch("https://api.documo.com/v1/faxes", {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}` },
        body: form as any,
      });
    } catch (err) {
      logger.error({ err, provider: "documo" }, "documo network error");
      return { ok: false, retryable: true, code: "network_error", message: String((err as Error).message) };
    }
    const json: any = await resp.json().catch(() => ({}));
    if (!resp.ok || !json?.id) {
      return {
        ok: false,
        retryable: resp.status === 429 || resp.status >= 500,
        code: `http_${resp.status}`,
        message: json?.message ?? `documo: HTTP ${resp.status}`,
        rawResponse: json,
      };
    }
    return { ok: true, externalFaxId: String(json.id), rawResponse: json };
  },

  async getStatus(creds, externalFaxId): Promise<string> {
    const apiKey = creds.api_key?.trim();
    if (!apiKey) return "unknown";
    try {
      const resp = await fetch(`https://api.documo.com/v1/faxes/${externalFaxId}`, {
        headers: { Authorization: `Bearer ${apiKey}` },
      });
      if (!resp.ok) return "unknown";
      const json: any = await resp.json().catch(() => ({}));
      return normalizeDocumoStatus(json?.status ?? "");
    } catch {
      return "unknown";
    }
  },
};
