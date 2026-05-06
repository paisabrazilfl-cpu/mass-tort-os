import type { LlmAdapter, LlmCompletionOutcome } from "./types";
import { logger } from "../logger";
import type OpenAI from "openai";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";

type OpenAIModule = typeof import("@workspace/integrations-openai-ai-server");
type OpenAIClient = OpenAIModule["openai"];
let envClient: OpenAIClient | undefined;

async function getEnvClient(): Promise<OpenAIClient> {
  if (!envClient) {
    const mod = await import("@workspace/integrations-openai-ai-server");
    envClient = mod.openai;
  }
  return envClient;
}

interface OpenAIErrorShape {
  status?: number;
  message?: string;
}

/**
 * OpenAI adapter. Uses the operator's vault api_key when present,
 * otherwise falls back to the Replit AI Integrations env-managed client.
 */
export const openaiAdapter: LlmAdapter = {
  provider: "openai",
  defaultModel: "gpt-5-mini",
  envManaged: true,

  async complete(creds, req): Promise<LlmCompletionOutcome> {
    try {
      const vaultKey = typeof creds?.api_key === "string" ? creds.api_key.trim() : "";
      let client: OpenAI | OpenAIClient;
      if (vaultKey) {
        const OpenAICtor = (await import("openai")).default;
        client = new OpenAICtor({ apiKey: vaultKey });
      } else {
        client = await getEnvClient();
      }

      const model = req.model || openaiAdapter.defaultModel;
      const messages: ChatCompletionMessageParam[] = [];
      if (req.systemPrompt) messages.push({ role: "system", content: req.systemPrompt });
      if (req.imageBase64 && req.imageMimeType) {
        messages.push({
          role: "user",
          content: [
            { type: "image_url", image_url: { url: `data:${req.imageMimeType};base64,${req.imageBase64}` } },
            { type: "text", text: req.prompt },
          ],
        });
      } else {
        messages.push({ role: "user", content: req.prompt });
      }

      const response = await client.chat.completions.create({
        model,
        max_tokens: req.maxTokens,
        messages,
      });
      const text = response.choices[0]?.message?.content ?? "";
      return {
        ok: true,
        text,
        model,
        usage: {
          input_tokens: response.usage?.prompt_tokens,
          output_tokens: response.usage?.completion_tokens,
        },
      };
    } catch (err) {
      const e = err as OpenAIErrorShape;
      const status = e?.status ?? 0;
      logger.error({ err, status, provider: "openai" }, "openai complete failed");
      return {
        ok: false,
        retryable: status === 429 || status >= 500,
        code: status ? `http_${status}` : "sdk_error",
        message: String(e?.message ?? err),
      };
    }
  },
};
