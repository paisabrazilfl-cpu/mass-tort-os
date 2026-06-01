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
  /**
   * Request EMBEDDED signing so a signer URL can be generated and texted to
   * the claimant (instead of the provider emailing them). Only honored when
   * the provider/integration supports it (Dropbox Sign needs an app
   * `client_id`; DocuSign uses a captive `clientUserId`). When embedded is not
   * available the adapter MUST fall back to the normal flow and simply omit
   * `signingUrl` from the result — never fail.
   */
  embedded?: boolean;
  /** Optional app client id for providers that require it for embedded signing (Dropbox Sign). */
  clientId?: string;
}

export interface SendEnvelopeResult {
  ok: true;
  externalEnvelopeId: string;
  /** Fresh, short-lived signer URL when embedded signing was requested and available. */
  signingUrl?: string;
  /** Provider signature id needed to regenerate a fresh signer URL later (Dropbox Sign). */
  embeddedSignatureId?: string;
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

/** Options for regenerating a fresh signer URL for an already-sent envelope. */
export interface CreateSignerUrlOptions {
  signerEmail: string;
  signerName: string;
  /** Where the provider returns the signer after they finish (back to /sign/:token). */
  returnUrl?: string;
  /** Dropbox Sign: the per-signer signature id captured at send time, if known. */
  embeddedSignatureId?: string | null;
  /** Dropbox Sign: the app client id required to mint an embedded sign URL. */
  clientId?: string | null;
}

export interface EsignAdapter {
  provider: string;
  send(creds: DecryptedCredentials, req: SendEnvelopeRequest): Promise<EsignSendOutcome>;
  /** Optional: download the signed PDF for a completed envelope. */
  downloadSigned?(creds: DecryptedCredentials, externalEnvelopeId: string): Promise<Buffer | null>;
  /** Optional: void/cancel an envelope. */
  cancel?(creds: DecryptedCredentials, externalEnvelopeId: string): Promise<void>;
  /**
   * Optional: mint a fresh, short-lived signer URL for an already-sent embedded
   * envelope. Returns null when the envelope was not sent embedded or the
   * provider cannot produce a URL. Used by the public /sign/:token redirect so
   * a claimant can tap the texted link later even after the original URL expired.
   */
  createSignerUrl?(
    creds: DecryptedCredentials,
    externalEnvelopeId: string,
    opts: CreateSignerUrlOptions,
  ): Promise<string | null>;
}
