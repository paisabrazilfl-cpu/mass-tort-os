import type { EmailAdapter, EmailSendOutcome } from "./sendgrid";
import { logger } from "../logger";

/**
 * Mailgun email. https://documentation.mailgun.com/en/latest/api-sending.html
 * Auth: HTTP Basic with "api:<api_key>". config.domain + optional region (us|eu).
 */
export const mailgunAdapter: EmailAdapter = {
  provider: "mailgun",
  async send(creds, req): Promise<EmailSendOutcome> {
    const apiKey = creds.api_key?.trim();
    if (!apiKey) return { ok: false, retryable: false, code: "no_api_key", message: "Mailgun api_key missing" };
    const cfg = (creds.config || {}) as Record<string, unknown>;
    const domain = String(cfg.domain ?? "").trim();
    const base = String(cfg.region ?? "us").toLowerCase() === "eu"
      ? "https://api.eu.mailgun.net"
      : "https://api.mailgun.net";
    if (!domain) return { ok: false, retryable: false, code: "no_domain", message: "Mailgun config.domain missing" };

    const params = new URLSearchParams();
    params.set("from", req.fromName ? `${req.fromName} <${req.fromEmail}>` : req.fromEmail);
    params.set("to", req.toName ? `${req.toName} <${req.to}>` : req.to);
    params.set("subject", req.subject);
    params.set("html", req.html);
    if (req.text) params.set("text", req.text);
    if (req.replyTo) params.set("h:Reply-To", req.replyTo);

    const url = `${base}/v3/${encodeURIComponent(domain)}/messages`;
    let resp: Response;
    try {
      resp = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Basic ${Buffer.from(`api:${apiKey}`).toString("base64")}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: params.toString(),
      });
    } catch (err) {
      logger.error({ err, provider: "mailgun" }, "mailgun network error");
      return { ok: false, retryable: true, code: "network_error", message: String((err as Error).message) };
    }
    const json: any = await resp.json().catch(() => ({}));
    if (!resp.ok || !json?.id) {
      return {
        ok: false,
        retryable: resp.status === 429 || resp.status >= 500,
        code: `http_${resp.status}`,
        message: json?.message ?? `mailgun: HTTP ${resp.status}`,
      };
    }
    return { ok: true, externalMessageId: String(json.id) };
  },
};
