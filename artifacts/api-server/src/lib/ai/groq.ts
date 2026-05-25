import type { LlmAdapter, LlmCompletionOutcome } from "./types";
import { openAiCompatChat } from "./http";

export const groqAdapter: LlmAdapter = {
  provider: "groq",
  defaultModel: "llama-3.3-70b-versatile",
  async complete(creds, req): Promise<LlmCompletionOutcome> {
    const apiKey = creds?.api_key?.trim();
    if (!apiKey) return { ok: false, retryable: false, code: "no_api_key", message: "Groq api_key missing" };
    return openAiCompatChat(
      { provider: "groq", baseUrl: "https://api.groq.com/openai/v1", apiKey, defaultModel: groqAdapter.defaultModel },
      req,
    );
  },
};
