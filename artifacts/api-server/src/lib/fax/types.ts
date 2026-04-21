/**
 * Common interface every fax adapter must implement.
 * Same contract pattern as e-sign adapters — return structured results, never throw on
 * expected provider errors.
 */

import type { DecryptedCredentials } from "../../routes/integrations";

export interface SendFaxRequest {
  pdf: Buffer;
  fileName: string;
  toNumber: string;
  fromNumber?: string;
  metadata?: Record<string, string>;
}

export interface SendFaxResult {
  ok: true;
  externalFaxId: string;
  rawResponse?: unknown;
}

export interface FaxError {
  ok: false;
  retryable: boolean;
  code: string;
  message: string;
  rawResponse?: unknown;
}

export type FaxSendOutcome = SendFaxResult | FaxError;

export interface FaxAdapter {
  provider: string;
  send(creds: DecryptedCredentials, req: SendFaxRequest): Promise<FaxSendOutcome>;
  /** Optional: poll status of a sent fax. */
  getStatus?(creds: DecryptedCredentials, externalFaxId: string): Promise<string>;
}
