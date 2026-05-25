import type { LlmAdapter } from "./types";
import { anthropicAdapter } from "./anthropic";
import { openaiAdapter } from "./openai";
import { googleGeminiAdapter } from "./google_gemini";
import { openrouterAdapter } from "./openrouter";
import { groqAdapter } from "./groq";
import { deepseekAdapter } from "./deepseek";
import { perplexityAdapter } from "./perplexity";
import { mistralAdapter } from "./mistral";
import { cohereAdapter } from "./cohere";
import { xaiGrokAdapter } from "./xai_grok";
import { fireworksAiAdapter } from "./fireworks_ai";

export * from "./types";

// Lazy registry — see lib/voice/index.ts for the cycle-breaking rationale.
let _registry: Record<string, LlmAdapter> | null = null;
function getRegistry(): Record<string, LlmAdapter> {
  if (_registry) return _registry;
  _registry = {
    [anthropicAdapter.provider]: anthropicAdapter,
    [openaiAdapter.provider]: openaiAdapter,
    [googleGeminiAdapter.provider]: googleGeminiAdapter,
    [openrouterAdapter.provider]: openrouterAdapter,
    [groqAdapter.provider]: groqAdapter,
    [deepseekAdapter.provider]: deepseekAdapter,
    [perplexityAdapter.provider]: perplexityAdapter,
    [mistralAdapter.provider]: mistralAdapter,
    [cohereAdapter.provider]: cohereAdapter,
    [xaiGrokAdapter.provider]: xaiGrokAdapter,
    [fireworksAiAdapter.provider]: fireworksAiAdapter,
  };
  return _registry;
}

export function getLlmAdapter(provider: string): LlmAdapter | null {
  return getRegistry()[provider] || null;
}

export function listLlmProviders(): string[] {
  return Object.keys(getRegistry());
}

/**
 * The hard-fallback adapter used when a chosen provider returns a
 * non-retryable error or no provider is configured. Anthropic is
 * env-managed via the Replit AI Integrations SDK, so it works without
 * any vault credentials.
 */
export const fallbackAdapter: LlmAdapter = anthropicAdapter;
