/**
 * Module-aware LLM dispatcher.
 *
 * Resolution order (first non-empty wins):
 *   1. Per-module env override         (AI_PROVIDER_<MODULE>)
 *   2. Global env default              (AI_PROVIDER)
 *   3. workflow_settings.llm_drafting_provider_integration_id  (drafting-ai only)
 *   4. workflow_settings.llm_default_provider_integration_id   (everything else)
 *   5. Hard fallback: anthropic via the env-managed Replit AI SDK
 *
 * On a non-retryable error from the chosen provider we automatically fall
 * back to anthropic so a misconfigured vault doesn't block intake.
 */
import { logger } from "./logger";
import { getLlmAdapter, fallbackAdapter, type LlmCompletionResult, type SupportedMime } from "./ai";
import { resolveProvider, isResolved, type ProviderCategory } from "./provider-router";

export type LLMModule =
  | "ai-extract"
  | "ai-fields"
  | "ai-ocr"
  | "drafting-ai"
  | "threat-analyzer"
  | "lead-intelligence";

const MODULE_ENV_KEY: Record<LLMModule, string> = {
  "ai-extract": "AI_PROVIDER_AI_EXTRACT",
  "ai-fields": "AI_PROVIDER_AI_FIELDS",
  "ai-ocr": "AI_PROVIDER_AI_OCR",
  "drafting-ai": "AI_PROVIDER_DRAFTING_AI",
  "threat-analyzer": "AI_PROVIDER_THREAT_ANALYZER",
  "lead-intelligence": "AI_PROVIDER_LEAD_INTELLIGENCE",
};

export interface LLMRequest {
  module: LLMModule;
  prompt: string;
  maxTokens: number;
  systemPrompt?: string;
  imageBase64?: string;
  imageMimeType?: SupportedMime;
  model?: string;
}

interface ResolvedLlm {
  provider: string;
  // null when env-managed (anthropic/openai via Replit AI SDK)
  credentials: import("./ai").LlmAdapter extends infer A
    ? Parameters<Extract<A, { complete: any }>["complete"]>[0]
    : never;
}

async function resolveLlmForModule(module: LLMModule): Promise<{ providerName: string; creds: any | null }> {
  const moduleOverride = process.env[MODULE_ENV_KEY[module]]?.toLowerCase();
  if (moduleOverride) return { providerName: moduleOverride, creds: null };

  const globalDefault = process.env["AI_PROVIDER"]?.toLowerCase();
  if (globalDefault) return { providerName: globalDefault, creds: null };

  const category: ProviderCategory = module === "drafting-ai" ? "llm_drafting" : "llm_default";
  const resolved = await resolveProvider(category);
  if (isResolved(resolved)) {
    return { providerName: resolved.provider, creds: resolved.credentials };
  }
  return { providerName: "openai", creds: null };
}

export async function callLLM({
  module, prompt, maxTokens, systemPrompt, imageBase64, imageMimeType, model,
}: LLMRequest): Promise<string> {
  const { providerName, creds } = await resolveLlmForModule(module);
  let adapter = getLlmAdapter(providerName);
  if (!adapter) {
    logger.warn({ module, providerName }, "Unknown LLM provider — falling back to anthropic");
    adapter = fallbackAdapter;
  }

  logger.debug({ module, provider: adapter.provider, hasImage: !!imageBase64 }, "callLLM dispatching");

  const out = await adapter.complete(creds, {
    prompt, maxTokens, systemPrompt, imageBase64, imageMimeType, model,
  });

  if (out.ok) return (out as LlmCompletionResult).text;

  if (out.retryable) {
    logger.warn({ module, provider: adapter.provider, code: out.code }, "LLM retryable error — single retry");
    const retry = await adapter.complete(creds, { prompt, maxTokens, systemPrompt, imageBase64, imageMimeType, model });
    if (retry.ok) return (retry as LlmCompletionResult).text;
  }

  if (adapter.provider !== fallbackAdapter.provider) {
    logger.warn(
      { module, primary_provider: adapter.provider, code: out.code, message: out.message },
      "LLM non-retryable error — falling back to anthropic env client",
    );
    const fb = await fallbackAdapter.complete(null, { prompt, maxTokens, systemPrompt, imageBase64, imageMimeType, model });
    if (fb.ok) return (fb as LlmCompletionResult).text;
    throw new Error(`LLM ${adapter.provider} failed (${out.code}) and anthropic fallback also failed: ${fb.message}`);
  }

  throw new Error(`LLM ${adapter.provider} failed: ${out.code} ${out.message}`);
}
