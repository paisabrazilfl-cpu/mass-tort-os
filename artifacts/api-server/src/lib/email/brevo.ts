import type { EmailAdapter, EmailSendOutcome } from "./sendgrid";
import { logger } from "../logger";

/**
 * Brevo (Sendinblue) Transactional Emails API.
 * https://developers.brevo.com/reference/sendtransacemail
 * Auth: api-key header. Vault: api_key.
 */
export const brevoAdapter: EmailAdapter = {
  provider: "brevo",
  async send(creds, req): Promise<EmailSendOutcome> {
    const apiKey = creds.api_key?.trim();
    if (!apiKey) return { ok: false, retryable: false, code: "no_api_key", message: "Brevo api_key missing" };

    const payload = {
      sender: { email: req.fromEmail, name: req.fromName },
      to: [{ email: req.to, name: req.toName }],
      subject: req.subject,
      htmlContent: req.html,
      textContent: req.text,
      replyTo: req.replyTo ? { email: req.replyTo } : undefined,
    };
    let resp: Response;
    try {
      resp = await fetch("https://api.brevo.com/v3/smtp/email", {
        method: "POST",
        headers: { "api-key": apiKey, "Content-Type": "application/json", accept: "application/json" },
        body: JSON.stringify(payload),
      });
    } catch (err) {
      logger.error({ err, provider: "brevo" }, "brevo network error");
      return { ok: false, retryable: true, code: "network_error", message: String((err as Error).message) };
    }
    const json: any = await resp.json().catch(() => ({}));
    if (!resp.ok || !json?.messageId) {
      return {
        ok: false,
        retryable: resp.status === 429 || resp.status >= 500,
        code: `http_${resp.status}`,
        message: json?.message ?? `brevo: HTTP ${resp.status}`,
      };
    }
    return { ok: true, externalMessageId: String(json.messageId) };
  },
};
