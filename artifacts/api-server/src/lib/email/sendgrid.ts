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
    const payload = {
      personalizations: [
        { to: [{ email: req.to, name: req.toName }] },
      ],
      from: { email: req.fromEmail, name: req.fromName },
      reply_to: req.replyTo ? { email: req.replyTo } : undefined,
      subject: req.subject,
      content: [
        ...(req.text ? [{ type: "text/plain", value: req.text }] : []),
        { type: "text/html", value: req.html },
      ],
    };

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

const ADAPTERS: Record<string, EmailAdapter> = {
  [sendgridAdapter.provider]: sendgridAdapter,
};

export function getEmailAdapter(provider: string): EmailAdapter | null {
  return ADAPTERS[provider] || null;
}
