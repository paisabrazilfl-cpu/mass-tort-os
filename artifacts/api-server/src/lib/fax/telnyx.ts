import type { FaxAdapter, FaxSendOutcome } from "./types";
import { logger } from "../logger";

/**
 * Telnyx Programmable Fax adapter.
 * API: https://developers.telnyx.com/docs/programmable-fax/send-receive-fax
 * Auth: Bearer API key.
 *
 * Telnyx requires the PDF as a publicly reachable URL OR as multipart upload — we use
 * inline base64 to keep things HIPAA-clean (PHI never leaves our infra in plaintext URLs).
 */
export const telnyxFaxAdapter: FaxAdapter = {
  provider: "telnyx_fax",

  async send(creds, req): Promise<FaxSendOutcome> {
    const apiKey = creds.api_key;
    if (!apiKey) {
      return { ok: false, retryable: false, code: "no_api_key", message: "Telnyx API key missing" };
    }
    if (!req.toNumber) {
      return { ok: false, retryable: false, code: "no_to_number", message: "Recipient fax number missing" };
    }
    if (!req.fromNumber) {
      return {
        ok: false,
        retryable: false,
        code: "no_from_number",
        message: "Sender fax number missing — set default_fax_from_number in Workflow Settings",
      };
    }

    const baseUrl = creds.api_url || "https://api.telnyx.com/v2";
    const url = `${baseUrl.replace(/\/$/, "")}/faxes`;

    const payload = {
      to: req.toNumber,
      from: req.fromNumber,
      media_name: req.fileName,
      // Telnyx accepts media_name + media_url OR contents (base64). Use contents for inline.
      contents: req.pdf.toString("base64"),
      monochrome: true,
      store_media: true,
      t38_enabled: true,
    };

    let response: Response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      });
    } catch (err) {
      logger.error({ err, provider: "telnyx_fax" }, "Network error sending fax");
      return { ok: false, retryable: true, code: "network_error", message: String((err as Error).message) };
    }

    let body: any = null;
    try {
      body = await response.json();
    } catch {
      // ignore
    }

    if (!response.ok) {
      const errMsg = body?.errors?.[0]?.detail || body?.errors?.[0]?.title || `HTTP ${response.status}`;
      const retryable = response.status >= 500 || response.status === 429;
      return {
        ok: false,
        retryable,
        code: body?.errors?.[0]?.code || `http_${response.status}`,
        message: errMsg,
        rawResponse: body,
      };
    }

    const faxId = body?.data?.id;
    if (!faxId) {
      return {
        ok: false,
        retryable: false,
        code: "no_fax_id",
        message: "Telnyx returned 200 but no fax id",
        rawResponse: body,
      };
    }

    return { ok: true, externalFaxId: faxId, rawResponse: body };
  },

  async getStatus(creds, externalFaxId): Promise<string> {
    const apiKey = creds.api_key;
    if (!apiKey) return "unknown";
    const baseUrl = creds.api_url || "https://api.telnyx.com/v2";
    try {
      const res = await fetch(`${baseUrl.replace(/\/$/, "")}/faxes/${externalFaxId}`, {
        headers: { Authorization: `Bearer ${apiKey}` },
      });
      if (!res.ok) return "unknown";
      const body = (await res.json()) as { data?: { status?: string } };
      return body?.data?.status || "unknown";
    } catch {
      return "unknown";
    }
  },
};
