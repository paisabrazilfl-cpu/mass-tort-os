/**
 * Module-aware LLM dispatcher — single-provider (Bitdeer AI Cloud).
 *
 * Every MTOS AI module maps to a Bitdeer capability role, and each role maps
 * to a concrete model (see lib/ai/bitdeer.ts → BITDEER_MODELS):
 *
 *   ai-extract        → planner   (Nemotron-3-Super-120B)
 *   ai-fields         → planner
 *   ai-ocr            → vision    (Nemotron-3-Nano-Omni-30B)
 *   drafting-ai       → chat      (Devstral-2-123B)
 *   threat-analyzer   → planner
 *   lead-intelligence → planner
 *   automations-assist→ code      (Devstral-2-123B)
 *
 * Any request that carries an image is routed to the vision model regardless
 * of module. An explicit `model` on the request overrides everything.
 *
 * Credentials: vault-first (integrations row provider="bitdeer"), with the
 * Bitdeer adapter falling back to the BITDEER_API_KEY env var when the vault
 * has no usable key.
 */
import { logger } from "./logger";
import { getLlmAdapter, fallbackAdapter, type LlmCompletionResult, type SupportedMime } from "./ai";
import { BITDEER_MODELS, type BitdeerRole } from "./ai/bitdeer";
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

/** Module → Bitdeer capability role. */
const MODULE_ROLE: Record<LLMModule, BitdeerRole> = {
  "ai-extract": "planner",
  "ai-fields": "planner",
  "ai-ocr": "vision",
  "drafting-ai": "chat",
  "threat-analyzer": "planner",
  "lead-intelligence": "planner",
  "automations-assist": "code",
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

/**
 * Resolve the Bitdeer vault credentials for a module. Returns null when no
 * vault row is configured — the adapter then falls back to BITDEER_API_KEY.
 *
 * Resolution order:
 *   1. workflow_settings FK (llm_drafting for drafting-ai, llm_default else),
 *      which also picks up the default "bitdeer" active integration row.
 *   2. Any active type="ai" integration whose api_key decrypts cleanly.
 */
async function resolveBitdeerCreds(module: LLMModule): Promise<DecryptedCredentials | null> {
  const category: ProviderCategory = module === "drafting-ai" ? "llm_drafting" : "llm_default";
  const resolved = await resolveProvider(category);
  if (isResolved(resolved)) return resolved.credentials;

  try {
    const { db, integrationsTable } = await import("@workspace/db");
    const { eq, and, desc } = await import("drizzle-orm");
    const rows = await db
      .select()
      .from(integrationsTable)
      .where(and(eq(integrationsTable.type, "ai"), eq(integrationsTable.status, "active")))
      .orderBy(desc(integrationsTable.created_at));
    const { getIntegrationCredentialsById } = await import("../routes/integrations");
    for (const row of rows) {
      const creds = await getIntegrationCredentialsById(row.id);
      if (creds?.api_key) return creds;
    }
  } catch (err) {
    logger.warn({ err }, "Bitdeer creds vault scan failed; falling back to BITDEER_API_KEY env");
  }
  return null;
}

const AUTH_SHAPED = /no.?auth|api[_ ]?key|no_api_key|unauthor|forbidden|http_401|http_403/i;

export async function callLLM({
  module,
  prompt,
  maxTokens,
  systemPrompt,
  imageBase64,
  imageMimeType,
  model,
}: LLMRequest): Promise<string> {
  const creds = await resolveBitdeerCreds(module);
  const adapter = getLlmAdapter("bitdeer") ?? fallbackAdapter;

  const resolvedModel =
    model || (imageBase64 ? BITDEER_MODELS.vision : BITDEER_MODELS[MODULE_ROLE[module]]);
  const reqArgs = { prompt, maxTokens, systemPrompt, imageBase64, imageMimeType, model: resolvedModel };

  logger.debug({ module, model: resolvedModel, hasImage: !!imageBase64 }, "callLLM dispatching (bitdeer)");

  let out = await adapter.complete(creds, reqArgs);
  if (!out.ok && out.retryable) {
    logger.warn({ module, code: out.code }, "Bitdeer retryable error — single retry");
    out = await adapter.complete(creds, reqArgs);
  }
  if (out.ok) return (out as LlmCompletionResult).text;

  if (AUTH_SHAPED.test(`${out.code} ${out.message}`)) {
    throw new Error(
      "Bitdeer AI is not configured. Open Integrations Hub → AI / LLM → Bitdeer AI Cloud, paste your inference API key, click Connect — or set BITDEER_API_KEY. Every AI feature works the moment the key is saved.",
    );
  }
  throw new Error(`Bitdeer AI call failed (${module}): ${out.code} ${out.message}`);
}
