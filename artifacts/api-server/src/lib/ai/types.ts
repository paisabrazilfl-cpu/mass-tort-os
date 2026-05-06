/**
 * Common interface every LLM adapter must implement.
 *
 * Adapters are stateless function wrappers that translate a normalized
 * `LlmCompletionRequest` into a vendor-specific HTTP call (or SDK call)
 * and return the assistant's text. They never throw on expected provider
 * errors — they return a structured `LlmError` instead, so the caller
 * can decide whether to retry, fall back, or surface the error.
 */

import type { DecryptedCredentials } from "../../routes/integrations";

export type SupportedMime = "image/jpeg" | "image/png" | "image/gif" | "image/webp";

export interface LlmCompletionRequest {
  model?: string;
  prompt: string;
  systemPrompt?: string;
  maxTokens: number;
  temperature?: number;
  imageBase64?: string;
  imageMimeType?: SupportedMime;
}

export interface LlmCompletionResult {
  ok: true;
  text: string;
  model: string;
  usage?: { input_tokens?: number; output_tokens?: number };
}

export interface LlmError {
  ok: false;
  retryable: boolean;
  code: string;
  message: string;
}

export type LlmCompletionOutcome = LlmCompletionResult | LlmError;

export interface LlmAdapter {
  provider: string;
  /** Default model name when the request omits one. */
  defaultModel: string;
  /** True if the adapter loads credentials from somewhere other than the vault row (e.g. Replit AI SDK env). */
  envManaged?: boolean;
  complete(creds: DecryptedCredentials | null, req: LlmCompletionRequest): Promise<LlmCompletionOutcome>;
}
