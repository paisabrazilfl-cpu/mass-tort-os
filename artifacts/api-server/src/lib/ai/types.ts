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

/**
 * Multi-turn chat surface. Adapters may implement this directly when
 * the provider exposes a native /chat/completions endpoint; the default
 * registry helper (`runChat`) falls back to flattening turns into
 * complete() for adapters that only ship the single-prompt surface.
 */
export interface LlmChatTurn {
  role: "system" | "user" | "assistant";
  content: string;
}
export interface LlmChatRequest {
  model?: string;
  messages: LlmChatTurn[];
  maxTokens: number;
  temperature?: number;
}

/**
 * Embeddings surface. Cohere and OpenAI implement directly; everything
 * else returns { ok: false, code: "EMBED_NOT_SUPPORTED" } so callers
 * can route to a supported provider.
 */
export interface LlmEmbedRequest {
  model?: string;
  inputs: string[];
}
export interface LlmEmbedResult {
  ok: true;
  model: string;
  vectors: number[][];
  usage?: { input_tokens?: number };
}
export type LlmEmbedOutcome = LlmEmbedResult | LlmError;

export interface LlmAdapter {
  provider: string;
  /** Default model name when the request omits one. */
  defaultModel: string;
  /** True if the adapter loads credentials from somewhere other than the vault row (e.g. Replit AI SDK env). */
  envManaged?: boolean;
  complete(creds: DecryptedCredentials | null, req: LlmCompletionRequest): Promise<LlmCompletionOutcome>;
  /** Optional native multi-turn chat. When absent, runChat() flattens to complete(). */
  chat?(creds: DecryptedCredentials | null, req: LlmChatRequest): Promise<LlmCompletionOutcome>;
  /** Optional embeddings. Only providers with a native embeddings API populate this. */
  embed?(creds: DecryptedCredentials | null, req: LlmEmbedRequest): Promise<LlmEmbedOutcome>;
}

/**
 * Adapter-agnostic chat helper: prefers adapter.chat when present,
 * otherwise renders messages as `Role: content` lines and calls
 * adapter.complete with the last user turn as the prompt and earlier
 * turns merged into the system prompt. This keeps the call surface
 * uniform across providers without forcing every adapter to implement
 * a chat endpoint.
 */
export async function runChat(
  adapter: LlmAdapter,
  creds: DecryptedCredentials | null,
  req: LlmChatRequest,
): Promise<LlmCompletionOutcome> {
  if (adapter.chat) return adapter.chat(creds, req);
  const lastUser = [...req.messages].reverse().find((m) => m.role === "user");
  const systemTurns = req.messages.filter((m) => m.role === "system").map((m) => m.content);
  const priorAssistant = req.messages
    .filter((m, i) => m.role !== "system" && (m !== lastUser || i !== req.messages.lastIndexOf(lastUser!)))
    .map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.content}`)
    .join("\n");
  return adapter.complete(creds, {
    model: req.model,
    prompt: lastUser?.content ?? "",
    systemPrompt: [systemTurns.join("\n\n"), priorAssistant].filter(Boolean).join("\n\n") || undefined,
    maxTokens: req.maxTokens,
    temperature: req.temperature,
  });
}

/** Adapter-agnostic embed helper: errors out cleanly when not supported. */
export async function runEmbed(
  adapter: LlmAdapter,
  creds: DecryptedCredentials | null,
  req: LlmEmbedRequest,
): Promise<LlmEmbedOutcome> {
  if (adapter.embed) return adapter.embed(creds, req);
  return {
    ok: false,
    retryable: false,
    code: "EMBED_NOT_SUPPORTED",
    message: `Provider "${adapter.provider}" does not implement embeddings.`,
  };
}
