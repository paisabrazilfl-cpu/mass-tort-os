/**
 * Module-aware LLM dispatcher.
 *
 * Resolution order (first non-empty wins):
 *   1. Per-module env override         (AI_PROVIDER_<MODULE>)
 *   2. Global env default              (AI_PROVIDER)
 *   3. workflow_settings.llm_drafting_provider_integration_id  (drafting-ai only)
 *   4. workflow_settings.llm_default_provider_integration_id   (everything else)
 *   5. Bitdeer BITDEER_API_KEY env var  (code/agent modules auto-route here)
 *   6. Hard fallback: anthropic via the env-managed Replit AI SDK
 *
 * FALLBACK LADDER
 * ───────────────
 * Tier 1  Primary provider (above resolution chain) — tried with one retry on
 *         transient errors (429 / 5xx).
 *
 * Tier 2  Bitdeer cheap_backup (openai/gpt-oss-20b) — attempted when the
 *         primary is NOT Bitdeer and BITDEER_API_KEY is present. Avoids
 *         burning the Anthropic seat for transient primary failures.
 *
 * Tier 3  Anthropic hard fallback (env-managed Replit AI SDK) — always
 *         available, last resort. A failure here throws.
 *
 * ROLE-AWARE MODEL ROUTING (Bitdeer only)
 * ────────────────────────────────────────
 * When the resolved provider is "bitdeer" and no explicit model string is
 * set on the request, callLLM looks up BITDEER_MODULE_MODELS[module] and
 * injects the role-appropriate model. This means:
 *   run-script  → Qwen3-Coder-Plus   (hard code, deep reasoning)
 *   ai-ocr      → Qwen3-235B          (vision / multimodal)
 *   drafting-ai → Nemotron-3-Super    (long-form planning)
 *   threat-analyzer → Gemma-4-E4B    (cheap classification)
 *   ai-agent    → Qwen3-235B          (multi-turn reasoning)
 *   everything else → Qwen3-235B      (default chat)
 */
import { logger } from "./logger";
import { getLlmAdapter, fallbackAdapter, type LlmCompletionResult, type SupportedMime } from "./ai";
import { BITDEER_MODELS, BITDEER_MODULE_MODELS, bitdeerAdapter } from "./ai/bitdeer";
import { resolveProvider, isResolved, type ProviderCategory } from "./provider-router";
import type { DecryptedCredentials } from "../routes/integrations";

export type LLMModule =
  | "ai-extract"
  | "ai-fields"
  | "ai-ocr"
  | "drafting-ai"
  | "threat-analyzer"
  | "lead-intelligence"
  | "run-script"    // Automation script nodes (JS/Python/Bash) — routes to bitdeer hard_code
  | "ai-agent";     // ai.agent automation node — routes to bitdeer chat

const MODULE_ENV_KEY: Record<LLMModule, string> = {
  "ai-extract":       "AI_PROVIDER_AI_EXTRACT",
  "ai-fields":        "AI_PROVIDER_AI_FIELDS",
  "ai-ocr":           "AI_PROVIDER_AI_OCR",
  "drafting-ai":      "AI_PROVIDER_DRAFTING_AI",
  "threat-analyzer":  "AI_PROVIDER_THREAT_ANALYZER",
  "lead-intelligence":"AI_PROVIDER_LEAD_INTELLIGENCE",
  "run-script":       "AI_PROVIDER_RUN_SCRIPT",
  "ai-agent":         "AI_PROVIDER_AI_AGENT",
};

/**
 * Modules that should default to Bitdeer when BITDEER_API_KEY is present and
 * no explicit provider is configured. Code and agent modules get task-specific
 * models (hard_code, chat) via BITDEER_MODULE_MODELS; general modules fall
 * through to the vault/workflow-settings resolution.
 */
// lead-intelligence is also routed through Bitdeer when the key is present so
// that the Abby internal assistant has a live AI connection without requiring
// a separate OpenAI or Anthropic Replit integration to be configured.
const BITDEER_PREFERRED_MODULES = new Set<LLMModule>(["run-script", "ai-agent", "lead-intelligence"]);

export interface LLMRequest {
  module: LLMModule;
  prompt: string;
  maxTokens: number;
  systemPrompt?: string;
  imageBase64?: string;
  imageMimeType?: SupportedMime;
  model?: string;
}

async function resolveLlmForModule(
  module: LLMModule,
): Promise<{ providerName: string; creds: DecryptedCredentials | null }> {
  const moduleOverride = process.env[MODULE_ENV_KEY[module]]?.toLowerCase();
  if (moduleOverride) return { providerName: moduleOverride, creds: null };

  const globalDefault = process.env["AI_PROVIDER"]?.toLowerCase();
  if (globalDefault) return { providerName: globalDefault, creds: null };

  const category: ProviderCategory = module === "drafting-ai" ? "llm_drafting" : "llm_default";
  const resolved = await resolveProvider(category);
  if (isResolved(resolved)) {
    return { providerName: resolved.provider, creds: resolved.credentials };
  }

  // Code and agent modules auto-route to Bitdeer when the key is present —
  // they get specialized models (hard_code, chat) that are better suited than
  // the generic OpenAI env-managed client.
  if (BITDEER_PREFERRED_MODULES.has(module) && process.env["BITDEER_API_KEY"]) {
    return { providerName: "bitdeer", creds: null };
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

  // Role-aware model routing for Bitdeer: inject the module-appropriate model
  // when no explicit model was requested by the caller.
  const effectiveModel: string | undefined =
    adapter.provider === "bitdeer" && !model
      ? (BITDEER_MODULE_MODELS[module] ?? BITDEER_MODELS.chat)
      : model;

  logger.debug(
    { module, provider: adapter.provider, model: effectiveModel ?? "(adapter default)", hasImage: !!imageBase64 },
    "callLLM dispatching",
  );

  const reqWithModule = {
    prompt, maxTokens, systemPrompt, imageBase64, imageMimeType,
    model: effectiveModel,
    module,
  } as any;

  const out = await adapter.complete(creds, reqWithModule);
  if (out.ok) return (out as LlmCompletionResult).text;

  // Single retry on transient primary errors (429, 5xx, timeout).
  if (out.retryable) {
    logger.warn({ module, provider: adapter.provider, code: out.code }, "callLLM: retryable error — single retry");
    const retry = await adapter.complete(creds, reqWithModule);
    if (retry.ok) return (retry as LlmCompletionResult).text;
  }

  // ── Tier 2: Bitdeer cheap_backup ────────────────────────────────────────
  // When the primary is NOT Bitdeer and BITDEER_API_KEY is available, try the
  // cheap_backup model (gpt-oss-20b) before spending the Anthropic hard-
  // fallback seat. This catches transient primary outages at lower cost.
  // We skip this tier when the primary was already Bitdeer (same infra) or
  // when the failure code suggests a network/infra issue on Bitdeer's side.
  const bitdeerKeyAvailable = !!process.env["BITDEER_API_KEY"];
  const primaryWasBitdeer = adapter.provider === "bitdeer";
  const isInfraFailure = out.code === "timeout" || out.code === "network_error";

  if (!primaryWasBitdeer && bitdeerKeyAvailable && !isInfraFailure) {
    logger.warn(
      { module, primary_provider: adapter.provider, code: out.code },
      "callLLM: primary failed — trying Bitdeer cheap_backup tier",
    );
    const cbReq = { ...reqWithModule, model: BITDEER_MODELS.cheap_backup };
    const cbResult = await bitdeerAdapter.complete(null, cbReq);
    if (cbResult.ok) {
      logger.info(
        { module, primary_provider: adapter.provider, cheap_backup_model: BITDEER_MODELS.cheap_backup },
        "callLLM: cheap_backup tier succeeded",
      );
      return (cbResult as LlmCompletionResult).text;
    }
    logger.warn(
      { module, code: cbResult.code, message: cbResult.message },
      "callLLM: cheap_backup tier also failed — escalating to Anthropic",
    );
  }

  // ── Tier 3: Anthropic hard fallback ─────────────────────────────────────
  if (adapter.provider !== fallbackAdapter.provider) {
    logger.warn(
      { module, primary_provider: adapter.provider, code: out.code, message: out.message },
      "callLLM: escalating to Anthropic env client (hard fallback)",
    );
    const fb = await fallbackAdapter.complete(null, { prompt, maxTokens, systemPrompt, imageBase64, imageMimeType, model });
    if (fb.ok) return (fb as LlmCompletionResult).text;
    throw new Error(`LLM ${adapter.provider} failed (${out.code}) and Anthropic fallback also failed: ${fb.message}`);
  }

  throw new Error(`LLM ${adapter.provider} failed: ${out.code} ${out.message}`);
}
