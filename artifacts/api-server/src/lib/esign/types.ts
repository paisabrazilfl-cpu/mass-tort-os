/**
 * Common interface every e-sign provider adapter must implement.
 * Adapters are pure functions: they take credentials + a request and return a normalized result.
 * NEVER throw on expected provider errors — return a structured EsignError so the worker can
 * decide whether to retry, dead-letter, or surface to the user.
 */

import type { DecryptedCredentials } from "../../routes/integrations";

export interface EsignSigner {
  name: string;
  email: string;
  role?: string;
}

export interface SendEnvelopeRequest {
  pdf: Buffer;
  fileName: string;
  subject: string;
  message?: string;
  signers: EsignSigner[];
  metadata?: Record<string, string>;
  expireInDays?: number;
}

export interface SendEnvelopeResult {
  ok: true;
  externalEnvelopeId: string;
  signingUrl?: string;
  rawResponse?: unknown;
}

export interface EsignError {
  ok: false;
  retryable: boolean;
  code: string;
  message: string;
  rawResponse?: unknown;
}

export type EsignSendOutcome = SendEnvelopeResult | EsignError;

export interface EsignAdapter {
  provider: string;
  send(creds: DecryptedCredentials, req: SendEnvelopeRequest): Promise<EsignSendOutcome>;
  /** Optional: download the signed PDF for a completed envelope. */
  downloadSigned?(creds: DecryptedCredentials, externalEnvelopeId: string): Promise<Buffer | null>;
  /** Optional: void/cancel an envelope. */
  cancel?(creds: DecryptedCredentials, externalEnvelopeId: string): Promise<void>;
}
