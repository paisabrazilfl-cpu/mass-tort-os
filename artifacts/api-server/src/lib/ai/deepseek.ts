import type { LlmAdapter, LlmCompletionOutcome } from "./types";
import { openAiCompatChat } from "./http";

export const deepseekAdapter: LlmAdapter = {
  provider: "deepseek",
  defaultModel: "deepseek-chat",
  async complete(creds, req): Promise<LlmCompletionOutcome> {
    const apiKey = creds?.api_key?.trim();
    if (!apiKey) return { ok: false, retryable: false, code: "no_api_key", message: "DeepSeek api_key missing" };
    return openAiCompatChat(
      { provider: "deepseek", baseUrl: "https://api.deepseek.com/v1", apiKey, defaultModel: deepseekAdapter.defaultModel },
      req,
    );
  },
};
