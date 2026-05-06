import type { LlmAdapter, LlmCompletionOutcome } from "./types";
import { openAiCompatChat } from "./http";

export const perplexityAdapter: LlmAdapter = {
  provider: "perplexity",
  defaultModel: "sonar",
  async complete(creds, req): Promise<LlmCompletionOutcome> {
    const apiKey = creds?.api_key?.trim();
    if (!apiKey) return { ok: false, retryable: false, code: "no_api_key", message: "Perplexity api_key missing" };
    return openAiCompatChat(
      { provider: "perplexity", baseUrl: "https://api.perplexity.ai", apiKey, defaultModel: perplexityAdapter.defaultModel },
      req,
    );
  },
};
