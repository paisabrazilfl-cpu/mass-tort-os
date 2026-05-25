import type { LlmAdapter, LlmCompletionOutcome } from "./types";
import { openAiCompatChat } from "./http";

/**
 * OpenRouter adapter — proxies to 200+ models behind one OpenAI-compatible API.
 * https://openrouter.ai/docs
 */
export const openrouterAdapter: LlmAdapter = {
  provider: "openrouter",
  defaultModel: "openai/gpt-4o-mini",

  async complete(creds, req): Promise<LlmCompletionOutcome> {
    const apiKey = creds?.api_key?.trim();
    if (!apiKey) return { ok: false, retryable: false, code: "no_api_key", message: "OpenRouter api_key missing" };

    return openAiCompatChat(
      {
        provider: "openrouter",
        baseUrl: "https://openrouter.ai/api/v1",
        apiKey,
        defaultModel: openrouterAdapter.defaultModel,
        buildHeaders: (key) => ({
          Authorization: `Bearer ${key}`,
          "Content-Type": "application/json",
          "HTTP-Referer": "https://mtos.local",
          "X-Title": "Mass Tort OS",
        }),
      },
      req,
    );
  },
};
