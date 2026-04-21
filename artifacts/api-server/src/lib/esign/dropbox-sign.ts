import type { EsignAdapter, EsignSendOutcome } from "./types";
import { logger } from "../logger";

/**
 * Dropbox Sign (formerly HelloSign) adapter.
 * API: https://developers.hellosign.com/api/reference/operation/signatureRequestSend
 * Auth: HTTP Basic with API key as username, empty password.
 *
 * Uses /signature_request/send (not template-based) since our templates are
 * arbitrary admin-uploaded PDFs.
 */
export const dropboxSignAdapter: EsignAdapter = {
  provider: "dropbox_sign",

  async send(creds, req): Promise<EsignSendOutcome> {
    const apiKey = creds.api_key;
    if (!apiKey) {
      return { ok: false, retryable: false, code: "no_api_key", message: "Dropbox Sign API key missing" };
    }

    const baseUrl = creds.api_url || "https://api.hellosign.com/v3";
    const url = `${baseUrl.replace(/\/$/, "")}/signature_request/send`;

    const form = new FormData();
    form.append("title", req.subject);
    form.append("subject", req.subject);
    if (req.message) form.append("message", req.message);
    if (req.expireInDays) form.append("signing_options[default_type]", "draw");

    const blob = new Blob([new Uint8Array(req.pdf)], { type: "application/pdf" });
    form.append("file[0]", blob, req.fileName);

    req.signers.forEach((s, i) => {
      form.append(`signers[${i}][name]`, s.name);
      form.append(`signers[${i}][email_address]`, s.email);
      if (s.role) form.append(`signers[${i}][role]`, s.role);
    });

    if (req.metadata) {
      for (const [k, v] of Object.entries(req.metadata)) {
        form.append(`metadata[${k}]`, v);
      }
    }

    form.append("test_mode", process.env.NODE_ENV === "production" ? "0" : "1");

    let response: Response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Basic ${Buffer.from(`${apiKey}:`).toString("base64")}`,
        },
        body: form,
      });
    } catch (err) {
      logger.error({ err, provider: "dropbox_sign" }, "Network error sending envelope");
      return { ok: false, retryable: true, code: "network_error", message: String((err as Error).message) };
    }

    let body: any = null;
    try {
      body = await response.json();
    } catch {
      // ignore
    }

    if (!response.ok) {
      const errMsg = body?.error?.error_msg || body?.error_msg || `HTTP ${response.status}`;
      const retryable = response.status >= 500 || response.status === 429;
      return {
        ok: false,
        retryable,
        code: body?.error?.error_name || `http_${response.status}`,
        message: errMsg,
        rawResponse: body,
      };
    }

    const sigReq = body?.signature_request;
    if (!sigReq?.signature_request_id) {
      return {
        ok: false,
        retryable: false,
        code: "no_envelope_id",
        message: "Dropbox Sign returned 200 but no signature_request_id",
        rawResponse: body,
      };
    }

    return {
      ok: true,
      externalEnvelopeId: sigReq.signature_request_id,
      rawResponse: body,
    };
  },

  async downloadSigned(creds, externalEnvelopeId): Promise<Buffer | null> {
    const apiKey = creds.api_key;
    if (!apiKey) return null;
    const baseUrl = creds.api_url || "https://api.hellosign.com/v3";
    const url = `${baseUrl.replace(/\/$/, "")}/signature_request/files/${externalEnvelopeId}?file_type=pdf`;
    try {
      const res = await fetch(url, {
        headers: { Authorization: `Basic ${Buffer.from(`${apiKey}:`).toString("base64")}` },
      });
      if (!res.ok) return null;
      const ab = await res.arrayBuffer();
      return Buffer.from(ab);
    } catch (err) {
      logger.error({ err, externalEnvelopeId }, "Failed to download signed Dropbox Sign PDF");
      return null;
    }
  },

  async cancel(creds, externalEnvelopeId): Promise<void> {
    const apiKey = creds.api_key;
    if (!apiKey) return;
    const baseUrl = creds.api_url || "https://api.hellosign.com/v3";
    const url = `${baseUrl.replace(/\/$/, "")}/signature_request/cancel/${externalEnvelopeId}`;
    try {
      await fetch(url, {
        method: "POST",
        headers: { Authorization: `Basic ${Buffer.from(`${apiKey}:`).toString("base64")}` },
      });
    } catch (err) {
      logger.error({ err, externalEnvelopeId }, "Failed to cancel Dropbox Sign envelope");
    }
  },
};
