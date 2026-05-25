import type { LlmAdapter, LlmCompletionOutcome } from "./types";
import { openAiCompatChat } from "./http";

export const fireworksAiAdapter: LlmAdapter = {
  provider: "fireworks_ai",
  defaultModel: "accounts/fireworks/models/llama-v3p1-70b-instruct",
  async complete(creds, req): Promise<LlmCompletionOutcome> {
    const apiKey = creds?.api_key?.trim();
    if (!apiKey) return { ok: false, retryable: false, code: "no_api_key", message: "Fireworks api_key missing" };
    return openAiCompatChat(
      { provider: "fireworks_ai", baseUrl: "https://api.fireworks.ai/inference/v1", apiKey, defaultModel: fireworksAiAdapter.defaultModel },
      req,
    );
  },
};
