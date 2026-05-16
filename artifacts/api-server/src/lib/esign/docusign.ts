import type { EsignAdapter, EsignSendOutcome } from "./types";
import { logger } from "../logger";

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
    // In production environments a missing api_url silently routes signers
    // to demo.docusign.net, where they CAN sign — but the envelope never
    // reaches the real account. Refuse to silently demo in production
    // and warn loudly in dev so the misconfig is impossible to miss.
    const apiBase = creds.api_url || "https://demo.docusign.net/restapi";
    const isDemo = /demo\.docusign\.net/i.test(apiBase);
    if (isDemo) {
      if (process.env["NODE_ENV"] === "production") {
        logger.error(
          { apiBase, fileName: req?.fileName, subject: req?.subject },
          "DocuSign send refused: api_url is demo.docusign.net in production — set api_url to the real account's REST endpoint",
        );
        return {
          ok: false,
          retryable: false,
          code: "demo_url_in_production",
          message: "DocuSign integration is pointing at demo.docusign.net in a production environment. Refusing to send. Set api_url to https://na4.docusign.net/restapi (or your account's real base URL).",
        };
      }
      logger.warn(
        { apiBase, fileName: req?.fileName, subject: req?.subject },
        "DocuSign: using demo.docusign.net — set creds.api_url before production",
      );
    }

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

    const recipients = {
      signers: req.signers.map((s, i) => ({
        email: s.email,
        name: s.name,
        recipientId: String(i + 1),
        routingOrder: String(i + 1),
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
      // 20 s cap. Envelope creation is the heaviest DocuSign call (it
      // accepts base64-embedded documents); even so it usually completes
      // in <5 s. A hung call without this signal blocks the worker until
      // the kernel TCP timeout fires (minutes).
      response = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(20_000),
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

    return {
      ok: true,
      externalEnvelopeId: body.envelopeId,
      rawResponse: body,
    };
  },

  async downloadSigned(creds, externalEnvelopeId): Promise<Buffer | null> {
    const accessToken = creds.api_key;
    const accountId = creds.account_sid;
    const apiBase = creds.api_url || "https://demo.docusign.net/restapi";
    if (!accessToken || !accountId) return null;
    const url = `${apiBase.replace(/\/$/, "")}/v2.1/accounts/${accountId}/envelopes/${externalEnvelopeId}/documents/combined`;
    try {
      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${accessToken}` },
        signal: AbortSignal.timeout(30_000),
      });
      if (!res.ok) return null;
      const ab = await res.arrayBuffer();
      return Buffer.from(ab);
    } catch (err) {
      logger.error({ err, externalEnvelopeId }, "Failed to download signed DocuSign PDF");
      return null;
    }
  },
};
