import type { EsignAdapter, EsignSendOutcome } from "./types";
import { logger } from "../logger";

function basicAuth(apiKey: string): string {
  return `Basic ${Buffer.from(`${apiKey}:`).toString("base64")}`;
}

/**
 * Fetch a fresh embedded sign URL for a given per-signer signature id.
 * Dropbox Sign embedded sign URLs are short-lived, so we mint a new one on
 * every claimant tap. Returns null on any failure (caller degrades gracefully).
 */
async function fetchEmbeddedSignUrl(
  apiKey: string,
  baseUrl: string,
  signatureId: string,
): Promise<string | null> {
  const url = `${baseUrl.replace(/\/$/, "")}/embedded/sign_url/${signatureId}`;
  try {
    const res = await fetch(url, { headers: { Authorization: basicAuth(apiKey) } });
    if (!res.ok) {
      logger.warn({ status: res.status, signatureId }, "Dropbox Sign embedded sign_url fetch failed");
      return null;
    }
    const body: any = await res.json();
    const signUrl = body?.embedded?.sign_url;
    return typeof signUrl === "string" && signUrl.length > 0 ? signUrl : null;
  } catch (err) {
    logger.error({ err, signatureId }, "Dropbox Sign embedded sign_url network error");
    return null;
  }
}

/** Pull the first signer's signature id out of a signature_request body. */
function firstSignatureId(sigReq: any): string | null {
  const sig = Array.isArray(sigReq?.signatures) ? sigReq.signatures[0] : null;
  return typeof sig?.signature_id === "string" ? sig.signature_id : null;
}

/**
 * Dropbox Sign (formerly HelloSign) adapter.
 * API: https://developers.hellosign.com/api/reference/operation/signatureRequestSend
 * Auth: HTTP Basic with API key as username, empty password.
 *
 * Uses /signature_request/send for the normal (provider-emails-the-signer)
 * flow and /signature_request/create_embedded when embedded signing is
 * requested AND an app `client_id` is configured — embedded signing yields a
 * sign URL we can text to the claimant. Templates are arbitrary admin-uploaded
 * PDFs, so we never use Dropbox's template endpoints.
 */
export const dropboxSignAdapter: EsignAdapter = {
  provider: "dropbox_sign",

  async send(creds, req): Promise<EsignSendOutcome> {
    const apiKey = creds.api_key;
    if (!apiKey) {
      return { ok: false, retryable: false, code: "no_api_key", message: "Dropbox Sign API key missing" };
    }

    const baseUrl = creds.api_url || "https://api.hellosign.com/v3";
    // Embedded signing requires an app client_id. Fall back to the normal flow
    // (provider emails the signer) when embedded was not requested or no
    // client_id is configured — never fail.
    const clientId = req.clientId || (creds as Record<string, unknown>)["client_id"];
    const useEmbedded = req.embedded === true && typeof clientId === "string" && clientId.length > 0;
    const endpoint = useEmbedded ? "/signature_request/create_embedded" : "/signature_request/send";
    const url = `${baseUrl.replace(/\/$/, "")}${endpoint}`;

    const form = new FormData();
    form.append("title", req.subject);
    form.append("subject", req.subject);
    if (req.message) form.append("message", req.message);
    if (req.expireInDays) form.append("signing_options[default_type]", "draw");
    if (useEmbedded) form.append("client_id", clientId as string);

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
          Authorization: basicAuth(apiKey),
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

    // For embedded requests, mint the first signer's sign URL now so the worker
    // can text it. URL minting failure is non-fatal — the envelope was sent and
    // the /sign route can regenerate later from the captured signature id.
    let signingUrl: string | undefined;
    let embeddedSignatureId: string | undefined;
    if (useEmbedded) {
      const sigId = firstSignatureId(sigReq);
      if (sigId) {
        embeddedSignatureId = sigId;
        const minted = await fetchEmbeddedSignUrl(apiKey, baseUrl, sigId);
        if (minted) signingUrl = minted;
      }
    }

    return {
      ok: true,
      externalEnvelopeId: sigReq.signature_request_id,
      ...(signingUrl ? { signingUrl } : {}),
      ...(embeddedSignatureId ? { embeddedSignatureId } : {}),
      rawResponse: body,
    };
  },

  async createSignerUrl(creds, externalEnvelopeId, opts): Promise<string | null> {
    const apiKey = creds.api_key;
    if (!apiKey) return null;
    const baseUrl = creds.api_url || "https://api.hellosign.com/v3";

    // Prefer the signature id captured at send time; otherwise look it up from
    // the signature request so an older envelope still resolves.
    let signatureId = opts.embeddedSignatureId ?? null;
    if (!signatureId) {
      try {
        const res = await fetch(
          `${baseUrl.replace(/\/$/, "")}/signature_request/${externalEnvelopeId}`,
          { headers: { Authorization: basicAuth(apiKey) } },
        );
        if (res.ok) {
          const body: any = await res.json();
          signatureId = firstSignatureId(body?.signature_request);
        }
      } catch (err) {
        logger.error({ err, externalEnvelopeId }, "Dropbox Sign signature lookup failed");
      }
    }
    if (!signatureId) return null;
    return fetchEmbeddedSignUrl(apiKey, baseUrl, signatureId);
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
