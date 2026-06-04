import { logger } from "../logger";
import type { DecryptedCredentials } from "../../routes/integrations";

export interface EmailSendRequest {
  to: string;
  toName?: string;
  fromEmail: string;
  fromName?: string;
  subject: string;
  html: string;
  text?: string;
  replyTo?: string;
  /** SendGrid dynamic template ID (e.g. "d-9aaeefe05abe4c3d82f53d96b76708d1") */
  templateId?: string;
  /** Dynamic template substitution data (maps handlebars {{variable}} names to values) */
  templateData?: Record<string, string>;
}

export interface EmailSendResult {
  ok: true;
  externalMessageId?: string;
}

export interface EmailError {
  ok: false;
  retryable: boolean;
  code: string;
  message: string;
}

export type EmailSendOutcome = EmailSendResult | EmailError;

export interface EmailAdapter {
  provider: string;
  send(creds: DecryptedCredentials, req: EmailSendRequest): Promise<EmailSendOutcome>;
}

/**
 * SendGrid v3 mail adapter. Auth: Bearer API key.
 */
export const sendgridAdapter: EmailAdapter = {
  provider: "sendgrid",

  async send(creds, req): Promise<EmailSendOutcome> {
    const apiKey = creds.api_key;
    if (!apiKey) {
      return { ok: false, retryable: false, code: "no_api_key", message: "SendGrid API key missing" };
    }

    const url = "https://api.sendgrid.com/v3/mail/send";
    const payload: any = {
      personalizations: [
        {
          to: [{ email: req.to, name: req.toName }],
          ...(req.templateData ? { dynamic_template_data: req.templateData } : {}),
        },
      ],
      from: { email: req.fromEmail, name: req.fromName },
      reply_to: req.replyTo ? { email: req.replyTo } : undefined,
      subject: req.subject,
    };

    // Use SendGrid dynamic template if templateId provided
    if (req.templateId) {
      payload.template_id = req.templateId;
      // Remove content fields when using templates (SendGrid ignores them)
    } else {
      payload.content = [
        ...(req.text ? [{ type: "text/plain", value: req.text }] : []),
        { type: "text/html", value: req.html },
      ];
    }

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
      logger.error({ err }, "SendGrid network error");
      return { ok: false, retryable: true, code: "network_error", message: String((err as Error).message) };
    }

    if (!response.ok) {
      let body: any = null;
      try { body = await response.json(); } catch { /* ignore */ }
      const errMsg = body?.errors?.[0]?.message || `HTTP ${response.status}`;
      const retryable = response.status >= 500 || response.status === 429;
      return {
        ok: false,
        retryable,
        code: `http_${response.status}`,
        message: errMsg,
      };
    }

    return { ok: true, externalMessageId: response.headers.get("x-message-id") || undefined };
  },
};

// The canonical ADAPTERS map and lookup helpers now live in
// ./index.ts so new providers (postmark/resend/mailgun/aws_ses/brevo)
// can register without circular imports. We re-export from there for
// backwards compatibility with any caller that still does
// `import { getEmailAdapter } from ".../email/sendgrid"`.
export { getEmailAdapter, listEmailProviders } from "./index";
