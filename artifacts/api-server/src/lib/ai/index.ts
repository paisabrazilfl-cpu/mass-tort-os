import type { LlmAdapter } from "./types";
import { bitdeerAdapter } from "./bitdeer";

export * from "./types";

// Bitdeer AI Cloud is the single LLM / vision / embeddings engine. The
// multi-provider adapter zoo (anthropic, openai, gemini, openrouter, groq,
// deepseek, perplexity, mistral, cohere, xai, fireworks) was removed when the
// stack consolidated onto Bitdeer — see lib/ai/bitdeer.ts.
let _registry: Record<string, LlmAdapter> | null = null;
function getRegistry(): Record<string, LlmAdapter> {
  if (_registry) return _registry;
  _registry = { [bitdeerAdapter.provider]: bitdeerAdapter };
  return _registry;
}

export function getLlmAdapter(provider: string): LlmAdapter | null {
  return getRegistry()[provider] || null;
}

export function listLlmProviders(): string[] {
  return Object.keys(getRegistry());
}

/**
 * Hard-fallback adapter used when a chosen provider returns a non-retryable
 * error or none is configured. With a single-provider stack this is Bitdeer.
 */
export const fallbackAdapter: LlmAdapter = bitdeerAdapter;
