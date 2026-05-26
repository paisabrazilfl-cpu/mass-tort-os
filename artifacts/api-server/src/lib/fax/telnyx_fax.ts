import type { FaxAdapter, FaxSendOutcome } from "./types";
import { logger } from "../logger";

function normalizeTelnyxStatus(s: string): string {
  if (s === "delivered") return "delivered";
  if (s === "failed" || s === "declined" || s === "busy" || s === "no_answer") return "failed";
  return "pending"; // queued, processing, sending
}

/**
 * Telnyx Programmable Fax v2. https://developers.telnyx.com/docs/programmable-fax
 * Auth: Bearer api_key. config.connection_id required.
 *
 * Note: provider key is "telnyx_fax" so it is distinct from the SMS
 * Telnyx integration row — operators can run them on different keys.
 */
export const telnyxFaxAdapter: FaxAdapter = {
  provider: "telnyx_fax",

  async send(creds, req): Promise<FaxSendOutcome> {
    const apiKey = creds.api_key?.trim();
    if (!apiKey) return { ok: false, retryable: false, code: "no_api_key", message: "Telnyx Fax api_key missing" };
    if (!req.toNumber) return { ok: false, retryable: false, code: "no_to", message: "Recipient fax missing" };
    const cfg = (creds.config || {}) as Record<string, unknown>;
    const connectionId = String(cfg.connection_id ?? "").trim();
    if (!connectionId) {
      return { ok: false, retryable: false, code: "no_connection", message: "Telnyx Fax needs config.connection_id" };
    }
    const fromNumber = req.fromNumber || creds.fax_number || String(cfg.from_number ?? "");
    if (!fromNumber) {
      return { ok: false, retryable: false, code: "no_from", message: "Telnyx Fax needs fax_number on the integration" };
    }

    let resp: Response;
    try {
      resp = await fetch("https://api.telnyx.com/v2/faxes", {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          connection_id: connectionId,
          to: req.toNumber,
          from: fromNumber,
          media_name: req.fileName,
          media_url: undefined,
          // Telnyx accepts contents as base64 via the `contents` field on /faxes.
          contents: req.pdf.toString("base64"),
        }),
      });
    } catch (err) {
      logger.error({ err, provider: "telnyx_fax" }, "telnyx_fax network error");
      return { ok: false, retryable: true, code: "network_error", message: String((err as Error).message) };
    }
    const json: any = await resp.json().catch(() => ({}));
    if (!resp.ok || !json?.data?.id) {
      return {
        ok: false,
        retryable: resp.status === 429 || resp.status >= 500,
        code: `http_${resp.status}`,
        message: json?.errors?.[0]?.detail ?? `telnyx_fax: HTTP ${resp.status}`,
        rawResponse: json,
      };
    }
    return { ok: true, externalFaxId: String(json.data.id), rawResponse: json };
  },

  async getStatus(creds, externalFaxId): Promise<string> {
    const apiKey = creds.api_key?.trim();
    if (!apiKey) return "unknown";
    try {
      const resp = await fetch(`https://api.telnyx.com/v2/faxes/${externalFaxId}`, {
        headers: { Authorization: `Bearer ${apiKey}` },
      });
      if (!resp.ok) return "unknown";
      const json: any = await resp.json().catch(() => ({}));
      return normalizeTelnyxStatus(json?.data?.status ?? "");
    } catch {
      return "unknown";
    }
  },
};
