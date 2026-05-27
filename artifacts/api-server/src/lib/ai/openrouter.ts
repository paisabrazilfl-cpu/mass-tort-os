import type { LlmAdapter, LlmCompletionOutcome } from "./types";
import { openAiCompatChat } from "./http";

/**
 * OpenRouter adapter — proxies to 200+ models behind one OpenAI-compatible API.
 * https://openrouter.ai/docs
 *
 * Default models per MTOS function (all available via OpenRouter):
 *   ai-extract        → deepseek-ai/DeepSeek-V3-0324   ($0.25/$1.00)  structured extraction
 *   ai-fields         → Qwen/Qwen3-235B-A22B (2507)    ($0.20/$0.60)  field classification
 *   ai-ocr            → Qwen/Qwen3-VL-32B-Instruct     ($0.50/$1.50)  vision OCR
 *   drafting-ai       → mistralai/Mistral-Large-3-675B  ($0.50/$1.50)  demand letters / summaries
 *   threat-analyzer   → deepseek-ai/DeepSeek-R1-0528   ($0.50/$2.18)  reasoning / fraud detection
 *   lead-intelligence → deepseek-ai/DeepSeek-V3-0324   ($0.25/$1.00)  Abby agent / scoring
 *   (default)         → deepseek-ai/DeepSeek-V3-0324
 */
export const MODULE_MODELS: Record<string, string> = {
  "ai-extract":        "deepseek-ai/DeepSeek-V3-0324",
  "ai-fields":         "Qwen/Qwen3-235B-A22B (2507)",
  "ai-ocr":            "Qwen/Qwen3-VL-32B-Instruct",
  "drafting-ai":       "mistralai/Mistral-Large-3-675B-Instruct-2512",
  "threat-analyzer":   "deepseek-ai/DeepSeek-R1-0528",
  "lead-intelligence": "deepseek-ai/DeepSeek-V3-0324",
};

export const OPENROUTER_DEFAULT_MODEL = "deepseek-ai/DeepSeek-V3-0324";

export const openrouterAdapter: LlmAdapter = {
  provider: "openrouter",
  defaultModel: OPENROUTER_DEFAULT_MODEL,

  async complete(creds, req): Promise<LlmCompletionOutcome> {
    const apiKey = creds?.api_key?.trim();
    if (!apiKey) return { ok: false, retryable: false, code: "no_api_key", message: "OpenRouter api_key missing — add it via Integrations → OpenRouter" };

    const model = req.model || MODULE_MODELS[(req as any).module as string] || OPENROUTER_DEFAULT_MODEL;

    return openAiCompatChat(
      {
        provider: "openrouter",
        baseUrl: "https://openrouter.ai/api/v1",
        apiKey,
        defaultModel: model,
        buildHeaders: (key) => ({
          Authorization: `Bearer ${key}`,
          "Content-Type": "application/json",
          "HTTP-Referer": "https://masstortvelocity.com",
          "X-Title": "Mass Tort OS",
        }),
      },
      { ...req, model },
    );
  },
};
