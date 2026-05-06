import type { EmailAdapter, EmailSendOutcome } from "./sendgrid";
import { logger } from "../logger";

/**
 * Postmark transactional email. https://postmarkapp.com/developer/api/email-api
 * Auth: X-Postmark-Server-Token. Vault: api_key.
 */
export const postmarkAdapter: EmailAdapter = {
  provider: "postmark",
  async send(creds, req): Promise<EmailSendOutcome> {
    const apiKey = creds.api_key?.trim();
    if (!apiKey) return { ok: false, retryable: false, code: "no_api_key", message: "Postmark api_key missing" };

    const payload = {
      From: req.fromName ? `${req.fromName} <${req.fromEmail}>` : req.fromEmail,
      To: req.toName ? `${req.toName} <${req.to}>` : req.to,
      Subject: req.subject,
      HtmlBody: req.html,
      TextBody: req.text,
      ReplyTo: req.replyTo,
      MessageStream: (creds.config as any)?.message_stream || "outbound",
    };
    let resp: Response;
    try {
      resp = await fetch("https://api.postmarkapp.com/email", {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          "X-Postmark-Server-Token": apiKey,
        },
        body: JSON.stringify(payload),
      });
    } catch (err) {
      logger.error({ err, provider: "postmark" }, "postmark network error");
      return { ok: false, retryable: true, code: "network_error", message: String((err as Error).message) };
    }
    const json: any = await resp.json().catch(() => ({}));
    if (!resp.ok || !json?.MessageID) {
      return {
        ok: false,
        retryable: resp.status === 429 || resp.status >= 500,
        code: `http_${resp.status}`,
        message: json?.Message ?? `postmark: HTTP ${resp.status}`,
      };
    }
    return { ok: true, externalMessageId: String(json.MessageID) };
  },
};
