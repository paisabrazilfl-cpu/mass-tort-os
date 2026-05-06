/**
 * Email adapter registry. The original sendgrid.ts shipped its own ADAPTERS
 * map for backwards compatibility; this module is now the canonical source.
 * sendgrid.ts re-exports getEmailAdapter from here so callers don't have
 * to change.
 */
import type { EmailAdapter } from "./sendgrid";
import { sendgridAdapter } from "./sendgrid";
import { postmarkAdapter } from "./postmark";
import { resendAdapter } from "./resend";
import { mailgunAdapter } from "./mailgun";
import { awsSesAdapter } from "./aws_ses";
import { brevoAdapter } from "./brevo";

export type {
  EmailAdapter,
  EmailSendRequest,
  EmailSendResult,
  EmailError,
  EmailSendOutcome,
} from "./sendgrid";

// Lazy registry — see lib/voice/index.ts for the cycle-breaking rationale.
let _registry: Record<string, EmailAdapter> | null = null;
function getRegistry(): Record<string, EmailAdapter> {
  if (_registry) return _registry;
  _registry = {
    [sendgridAdapter.provider]: sendgridAdapter,
    [postmarkAdapter.provider]: postmarkAdapter,
    [resendAdapter.provider]: resendAdapter,
    [mailgunAdapter.provider]: mailgunAdapter,
    [awsSesAdapter.provider]: awsSesAdapter,
    [brevoAdapter.provider]: brevoAdapter,
  };
  return _registry;
}

export function getEmailAdapter(provider: string): EmailAdapter | null {
  return getRegistry()[provider] || null;
}

export function listEmailProviders(): string[] {
  return Object.keys(getRegistry());
}
