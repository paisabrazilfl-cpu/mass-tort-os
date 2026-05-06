import type { LlmAdapter, LlmCompletionOutcome } from "./types";
import { openAiCompatChat } from "./http";

export const xaiGrokAdapter: LlmAdapter = {
  provider: "xai_grok",
  defaultModel: "grok-2-latest",
  async complete(creds, req): Promise<LlmCompletionOutcome> {
    const apiKey = creds?.api_key?.trim();
    if (!apiKey) return { ok: false, retryable: false, code: "no_api_key", message: "xAI api_key missing" };
    return openAiCompatChat(
      { provider: "xai_grok", baseUrl: "https://api.x.ai/v1", apiKey, defaultModel: xaiGrokAdapter.defaultModel },
      req,
    );
  },
};
