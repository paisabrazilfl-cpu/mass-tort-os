import type { EsignAdapter, EsignSendOutcome } from "./types";
import { logger } from "../logger";
import { getPublicBaseUrl } from "./signing-token";

/**
 * POST a recipient view to mint a fresh, short-lived signing URL for a captive
 * (embedded) recipient. Returns null on any failure so callers degrade.
 */
async function createRecipientView(
  accessToken: string,
  accountId: string,
  apiBase: string,
  envelopeId: string,
  signer: { email: string; userName: string; clientUserId: string; returnUrl: string },
): Promise<string | null> {
  const url = `${apiBase.replace(/\/$/, "")}/v2.1/accounts/${accountId}/envelopes/${envelopeId}/views/recipient`;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        returnUrl: signer.returnUrl,
        authenticationMethod: "none",
        email: signer.email,
        userName: signer.userName,
        clientUserId: signer.clientUserId,
        recipientId: "1",
      }),
    });
    if (!res.ok) {
      logger.warn({ status: res.status, envelopeId }, "DocuSign recipient view failed");
      return null;
    }
    const body: any = await res.json();
    return typeof body?.url === "string" && body.url.length > 0 ? body.url : null;
  } catch (err) {
    logger.error({ err, envelopeId }, "DocuSign recipient view network error");
    return null;
  }
}

/**
 * DocuSign adapter (REST API v2.1).
 * Auth: OAuth2 JWT — but for the simplified path-of-least-resistance flow we accept a
 * pre-issued OAuth access token stored as `api_key` and the account_id stored in `account_sid`.
 * Admins can paste a token from DocuSign's "Apps and Keys" sandbox tool.
 *
 * For long-term automated token rotation, swap to the JWT grant flow inside this adapter.
 * The contract returned to the workflow engine does not change.
 */
export const docusignAdapter: EsignAdapter = {
  provider: "docusign",

  async send(creds, req): Promise<EsignSendOutcome> {
    const accessToken = creds.api_key;
    const accountId = creds.account_sid;
    const apiBase = creds.api_url || "https://demo.docusign.net/restapi";

    if (!accessToken) {
      return { ok: false, retryable: false, code: "no_access_token", message: "DocuSign access token missing (store as api_key)" };
    }
    if (!accountId) {
      return { ok: false, retryable: false, code: "no_account_id", message: "DocuSign account_id missing (store as account_sid)" };
    }

    const url = `${apiBase.replace(/\/$/, "")}/v2.1/accounts/${accountId}/envelopes`;

    const document = {
      documentBase64: req.pdf.toString("base64"),
      name: req.fileName,
      fileExtension: "pdf",
      documentId: "1",
    };

    // Embedded (captive) signing requires a clientUserId on each signer so we
    // can later mint a recipient-view URL to text. We key clientUserId off the
    // signer email (stable + unique within a packet). When not embedded, leave
    // it off so DocuSign emails the signer as before — never fail.
    const useEmbedded = req.embedded === true;
    const recipients = {
      signers: req.signers.map((s, i) => ({
        email: s.email,
        name: s.name,
        recipientId: String(i + 1),
        routingOrder: String(i + 1),
        ...(useEmbedded ? { clientUserId: s.email } : {}),
        tabs: {
          signHereTabs: [
            { anchorString: "/sig/", anchorXOffset: "0", anchorYOffset: "0", anchorUnits: "inches" },
          ],
        },
      })),
    };

    const payload = {
      emailSubject: req.subject,
      emailBlurb: req.message || "",
      documents: [document],
      recipients,
      status: "sent",
      customFields: req.metadata
        ? {
            textCustomFields: Object.entries(req.metadata).map(([name, value]) => ({
              name,
              value,
              required: "false",
              show: "false",
            })),
          }
        : undefined,
    };

    let response: Response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      });
    } catch (err) {
      logger.error({ err, provider: "docusign" }, "Network error sending DocuSign envelope");
      return { ok: false, retryable: true, code: "network_error", message: String((err as Error).message) };
    }

    let body: any = null;
    try {
      body = await response.json();
    } catch {
      // ignore
    }

    if (!response.ok) {
      const errMsg = body?.message || body?.errorCode || `HTTP ${response.status}`;
      const retryable = response.status >= 500 || response.status === 429 || response.status === 401;
      return {
        ok: false,
        retryable,
        code: body?.errorCode || `http_${response.status}`,
        message: errMsg,
        rawResponse: body,
      };
    }

    if (!body?.envelopeId) {
      return {
        ok: false,
        retryable: false,
        code: "no_envelope_id",
        message: "DocuSign returned success without envelopeId",
        rawResponse: body,
      };
    }

    // For embedded sends, mint the first signer's recipient-view URL now so the
    // worker can text it. Failure is non-fatal — the envelope is sent and the
    // /sign route can regenerate a fresh view on demand.
    let signingUrl: string | undefined;
    if (useEmbedded && req.signers[0]) {
      const first = req.signers[0];
      const minted = await createRecipientView(accessToken, accountId, apiBase, body.envelopeId, {
        email: first.email,
        userName: first.name,
        clientUserId: first.email,
        returnUrl: `${getPublicBaseUrl()}/sign/complete`,
      });
      if (minted) signingUrl = minted;
    }

    return {
      ok: true,
      externalEnvelopeId: body.envelopeId,
      ...(signingUrl ? { signingUrl } : {}),
      rawResponse: body,
    };
  },

  async createSignerUrl(creds, externalEnvelopeId, opts): Promise<string | null> {
    const accessToken = creds.api_key;
    const accountId = creds.account_sid;
    const apiBase = creds.api_url || "https://demo.docusign.net/restapi";
    if (!accessToken || !accountId) return null;
    return createRecipientView(accessToken, accountId, apiBase, externalEnvelopeId, {
      email: opts.signerEmail,
      userName: opts.signerName,
      // clientUserId MUST match what was set at send time (the signer email).
      clientUserId: opts.signerEmail,
      returnUrl: opts.returnUrl || `${getPublicBaseUrl()}/sign/complete`,
    });
  },

  async downloadSigned(creds, externalEnvelopeId): Promise<Buffer | null> {
    const accessToken = creds.api_key;
    const accountId = creds.account_sid;
    const apiBase = creds.api_url || "https://demo.docusign.net/restapi";
    if (!accessToken || !accountId) return null;
    const url = `${apiBase.replace(/\/$/, "")}/v2.1/accounts/${accountId}/envelopes/${externalEnvelopeId}/documents/combined`;
    try {
      const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
      if (!res.ok) return null;
      const ab = await res.arrayBuffer();
      return Buffer.from(ab);
    } catch (err) {
      logger.error({ err, externalEnvelopeId }, "Failed to download signed DocuSign PDF");
      return null;
    }
  },
};
