import type { FaxAdapter, FaxSendOutcome } from "./types";
import { logger } from "../logger";

function normalizeEfaxStatus(s: string): string {
  const lower = s.toLowerCase();
  if (lower === "delivered" || lower === "success" || lower === "sent") return "delivered";
  if (lower === "failed" || lower === "error" || lower === "declined") return "failed";
  return "pending";
}

/**
 * eFax Corporate adapter. eFax exposes a SOAP API plus a Mail-to-Fax
 * gateway. We use the modern REST-ish v1 endpoint published in the
 * Developer API. Vault api_key holds the OAuth Bearer token.
 */
export const efaxAdapter: FaxAdapter = {
  provider: "efax",

  async send(creds, req): Promise<FaxSendOutcome> {
    const apiKey = creds.api_key?.trim();
    if (!apiKey) return { ok: false, retryable: false, code: "no_api_key", message: "eFax api_key missing" };
    if (!req.toNumber) return { ok: false, retryable: false, code: "no_to", message: "Recipient fax missing" };

    const apiUrl = (creds.api_url?.trim() || "https://secure.efaxdeveloper.com/EFax_WebFax.serv") + "/api/v1/fax/send";
    const payload = {
      to: req.toNumber,
      fileName: req.fileName,
      contentType: "application/pdf",
      content: req.pdf.toString("base64"),
    };
    let resp: Response;
    try {
      resp = await fetch(apiUrl, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
    } catch (err) {
      logger.error({ err, provider: "efax" }, "efax network error");
      return { ok: false, retryable: true, code: "network_error", message: String((err as Error).message) };
    }
    const json: any = await resp.json().catch(() => ({}));
    if (!resp.ok || !json?.id) {
      return {
        ok: false,
        retryable: resp.status === 429 || resp.status >= 500,
        code: `http_${resp.status}`,
        message: json?.message ?? `efax: HTTP ${resp.status}`,
        rawResponse: json,
      };
    }
    return { ok: true, externalFaxId: String(json.id), rawResponse: json };
  },

  async getStatus(creds, externalFaxId): Promise<string> {
    const apiKey = creds.api_key?.trim();
    if (!apiKey) return "unknown";
    const baseUrl = creds.api_url?.trim() || "https://secure.efaxdeveloper.com/EFax_WebFax.serv";
    try {
      const resp = await fetch(`${baseUrl}/api/v1/fax/${externalFaxId}`, {
        headers: { Authorization: `Bearer ${apiKey}` },
      });
      if (!resp.ok) return "unknown";
      const json: any = await resp.json().catch(() => ({}));
      return normalizeEfaxStatus(json?.status ?? json?.fax_status ?? "");
    } catch {
      return "unknown";
    }
  },
};
