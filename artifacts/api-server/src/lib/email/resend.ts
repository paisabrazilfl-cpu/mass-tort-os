import type { EmailAdapter, EmailSendOutcome } from "./sendgrid";
import { logger } from "../logger";

/**
 * Resend transactional email. https://resend.com/docs/api-reference
 * Auth: Bearer api_key.
 */
export const resendAdapter: EmailAdapter = {
  provider: "resend",
  async send(creds, req): Promise<EmailSendOutcome> {
    const apiKey = creds.api_key?.trim();
    if (!apiKey) return { ok: false, retryable: false, code: "no_api_key", message: "Resend api_key missing" };

    const payload = {
      from: req.fromName ? `${req.fromName} <${req.fromEmail}>` : req.fromEmail,
      to: [req.to],
      subject: req.subject,
      html: req.html,
      text: req.text,
      reply_to: req.replyTo,
    };
    let resp: Response;
    try {
      resp = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
    } catch (err) {
      logger.error({ err, provider: "resend" }, "resend network error");
      return { ok: false, retryable: true, code: "network_error", message: String((err as Error).message) };
    }
    const json: any = await resp.json().catch(() => ({}));
    if (!resp.ok || !json?.id) {
      return {
        ok: false,
        retryable: resp.status === 429 || resp.status >= 500,
        code: `http_${resp.status}`,
        message: json?.message ?? `resend: HTTP ${resp.status}`,
      };
    }
    return { ok: true, externalMessageId: String(json.id) };
  },
};
