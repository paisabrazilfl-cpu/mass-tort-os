import type { EmailAdapter, EmailSendOutcome } from "./sendgrid";
import { logger } from "../logger";
import crypto from "crypto";

/**
 * AWS SES SendEmail v2 adapter using SigV4-signed REST.
 * https://docs.aws.amazon.com/ses/latest/APIReference-V2/API_SendEmail.html
 *
 * Vault fields:
 *   api_key        — AWS access key ID (AKIA...)
 *   client_secret  — AWS secret access key
 * config.region (default us-east-1).
 */
export const awsSesAdapter: EmailAdapter = {
  provider: "aws_ses",
  async send(creds, req): Promise<EmailSendOutcome> {
    const accessKeyId = creds.api_key?.trim();
    const secretAccessKey = creds.client_secret?.trim();
    if (!accessKeyId || !secretAccessKey) {
      return { ok: false, retryable: false, code: "no_credentials", message: "AWS SES needs api_key + client_secret" };
    }
    const region = String((creds.config as any)?.region ?? "us-east-1");
    const host = `email.${region}.amazonaws.com`;
    const url = `https://${host}/v2/email/outbound-emails`;
    const body = JSON.stringify({
      FromEmailAddress: req.fromName ? `${req.fromName} <${req.fromEmail}>` : req.fromEmail,
      Destination: { ToAddresses: [req.to] },
      ReplyToAddresses: req.replyTo ? [req.replyTo] : undefined,
      Content: {
        Simple: {
          Subject: { Data: req.subject, Charset: "UTF-8" },
          Body: {
            Html: { Data: req.html, Charset: "UTF-8" },
            Text: req.text ? { Data: req.text, Charset: "UTF-8" } : undefined,
          },
        },
      },
    });

    const headers = sigv4SignJson({
      accessKeyId,
      secretAccessKey,
      region,
      service: "ses",
      method: "POST",
      host,
      path: "/v2/email/outbound-emails",
      body,
    });

    let resp: Response;
    try {
      resp = await fetch(url, { method: "POST", headers, body });
    } catch (err) {
      logger.error({ err, provider: "aws_ses" }, "ses network error");
      return { ok: false, retryable: true, code: "network_error", message: String((err as Error).message) };
    }
    const json: any = await resp.json().catch(() => ({}));
    if (!resp.ok || !json?.MessageId) {
      return {
        ok: false,
        retryable: resp.status === 429 || resp.status >= 500,
        code: `http_${resp.status}`,
        message: json?.message ?? json?.Message ?? `ses: HTTP ${resp.status}`,
      };
    }
    return { ok: true, externalMessageId: String(json.MessageId) };
  },
};

interface SigV4Args {
  accessKeyId: string;
  secretAccessKey: string;
  region: string;
  service: string;
  method: string;
  host: string;
  path: string;
  body: string;
}

function sigv4SignJson(a: SigV4Args): Record<string, string> {
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  const dateStamp = amzDate.slice(0, 8);
  const contentType = "application/json";
  const hashedPayload = crypto.createHash("sha256").update(a.body).digest("hex");

  const canonicalHeaders =
    `content-type:${contentType}\nhost:${a.host}\nx-amz-content-sha256:${hashedPayload}\nx-amz-date:${amzDate}\n`;
  const signedHeaders = "content-type;host;x-amz-content-sha256;x-amz-date";

  const canonicalRequest = [
    a.method, a.path, "", canonicalHeaders, signedHeaders, hashedPayload,
  ].join("\n");

  const credentialScope = `${dateStamp}/${a.region}/${a.service}/aws4_request`;
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    credentialScope,
    crypto.createHash("sha256").update(canonicalRequest).digest("hex"),
  ].join("\n");

  const kDate = hmac(`AWS4${a.secretAccessKey}`, dateStamp);
  const kRegion = hmac(kDate, a.region);
  const kService = hmac(kRegion, a.service);
  const kSigning = hmac(kService, "aws4_request");
  const signature = crypto.createHmac("sha256", kSigning).update(stringToSign).digest("hex");

  const auth =
    `AWS4-HMAC-SHA256 Credential=${a.accessKeyId}/${credentialScope}, ` +
    `SignedHeaders=${signedHeaders}, Signature=${signature}`;

  return {
    "Content-Type": contentType,
    Host: a.host,
    "X-Amz-Date": amzDate,
    "X-Amz-Content-Sha256": hashedPayload,
    Authorization: auth,
  };
}

function hmac(key: crypto.BinaryLike | crypto.KeyObject, data: string): Buffer {
  return crypto.createHmac("sha256", key as any).update(data).digest();
}
