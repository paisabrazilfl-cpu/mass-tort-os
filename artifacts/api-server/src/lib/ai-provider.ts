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
import type { DecryptedCredentials } from "../routes/integrations";

export type LLMModule =
  | "ai-extract"
  | "ai-fields"
  | "ai-ocr"
  | "drafting-ai"
  | "threat-analyzer"
  | "lead-intelligence"
  | "automations-assist";

const MODULE_ENV_KEY: Record<LLMModule, string> = {
  "ai-extract": "AI_PROVIDER_AI_EXTRACT",
  "ai-fields": "AI_PROVIDER_AI_FIELDS",
  "ai-ocr": "AI_PROVIDER_AI_OCR",
  "drafting-ai": "AI_PROVIDER_DRAFTING_AI",
  "threat-analyzer": "AI_PROVIDER_THREAT_ANALYZER",
  "lead-intelligence": "AI_PROVIDER_LEAD_INTELLIGENCE",
  "automations-assist": "AI_PROVIDER_AUTOMATIONS_ASSIST",
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

  // Final fallback before assuming "openai" (which then crashes with
  // "no auth method" when neither env nor vault has a key). Look for
  // ANY active integration with type=ai whose api_key decrypts cleanly
  // and use it. This is the path that gets the Assistant working when
  // the operator pasted a key into Integrations Hub but didn't link it
  // via Workflow Settings → llm_default_provider_integration_id.
  try {
    const { db, integrationsTable } = await import("@workspace/db");
    const { eq, and, desc } = await import("drizzle-orm");
    const rows = await db
      .select()
      .from(integrationsTable)
      .where(and(eq(integrationsTable.type, "ai"), eq(integrationsTable.status, "active")))
      .orderBy(desc(integrationsTable.created_at));
    if (rows.length > 0) {
      const { getIntegrationCredentialsById } = await import("../routes/integrations");
      for (const row of rows) {
        const creds = await getIntegrationCredentialsById(row.id);
        if (creds?.api_key) {
          logger.info(
            { module, picked_provider: row.provider, integration_id: row.id },
            "LLM auto-resolve: found unconfigured active AI integration with valid api_key",
          );
          return { providerName: row.provider, creds };
        }
      }
    }
  } catch (err) {
    logger.warn({ err }, "LLM auto-resolve scan failed; falling through to openai default");
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
    // If BOTH legs failed with auth-shaped errors, the deploy genuinely has
    // no working LLM provider — surface a single actionable message instead
    // of the cryptic SDK string. This is what the UI ends up showing in the
    // Assistant toast.
    const authShaped =
      /no.?auth|api[_ ]?key|authToken|unauthor|forbidden|api.key/i.test(`${out.message} ${fb.message}`);
    if (authShaped) {
      throw new Error(
        "No LLM provider is configured. Open the Integrations Hub → AI / LLM → Connect any of Anthropic, OpenAI, OpenRouter, Google Gemini, Groq, DeepSeek, etc. — paste an API key, click Connect. The Assistant works the moment one provider has a valid key.",
      );
    }
    throw new Error(`LLM ${adapter.provider} failed (${out.code}) and anthropic fallback also failed: ${fb.message}`);
  }

  // Single-leg failure (adapter IS the fallback already — env Anthropic).
  // Same auth-shape check so the operator gets the actionable message.
  if (/no.?auth|api[_ ]?key|authToken|unauthor|forbidden|api.key/i.test(out.message)) {
    throw new Error(
      "No LLM provider is configured. Open the Integrations Hub → AI / LLM → Connect any of Anthropic, OpenAI, OpenRouter, Google Gemini, Groq, DeepSeek, etc. — paste an API key, click Connect. The Assistant works the moment one provider has a valid key.",
    );
  }
  throw new Error(`LLM ${adapter.provider} failed: ${out.code} ${out.message}`);
}
