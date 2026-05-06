/**
 * Common interface every SMS adapter must implement.
 * Outbound send only — webhook ingestion lives in routes/webhooks.ts.
 */
import type { DecryptedCredentials } from "../../routes/integrations";

export interface SmsSendRequest {
  to: string;
  from?: string;
  body: string;
  metadata?: Record<string, string>;
}

export interface SmsSendResult {
  ok: true;
  externalMessageId: string;
  rawResponse?: unknown;
}

export interface SmsError {
  ok: false;
  retryable: boolean;
  code: string;
  message: string;
  rawResponse?: unknown;
}

export type SmsSendOutcome = SmsSendResult | SmsError;

export interface SmsAdapter {
  provider: string;
  send(creds: DecryptedCredentials, req: SmsSendRequest): Promise<SmsSendOutcome>;
}
