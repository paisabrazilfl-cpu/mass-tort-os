import type { LlmAdapter, LlmCompletionOutcome } from "./types";
import { openAiCompatChat } from "./http";

export const mistralAdapter: LlmAdapter = {
  provider: "mistral",
  defaultModel: "mistral-small-latest",
  async complete(creds, req): Promise<LlmCompletionOutcome> {
    const apiKey = creds?.api_key?.trim();
    if (!apiKey) return { ok: false, retryable: false, code: "no_api_key", message: "Mistral api_key missing" };
    return openAiCompatChat(
      { provider: "mistral", baseUrl: "https://api.mistral.ai/v1", apiKey, defaultModel: mistralAdapter.defaultModel },
      req,
    );
  },
};
