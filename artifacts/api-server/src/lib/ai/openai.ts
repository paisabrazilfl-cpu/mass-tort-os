import type { LlmAdapter, LlmCompletionOutcome } from "./types";
import { logger } from "../logger";

type OpenAIModule = typeof import("@workspace/integrations-openai-ai-server");
let envClient: OpenAIModule["openai"] | undefined;

async function getEnvClient(): Promise<OpenAIModule["openai"]> {
  if (!envClient) {
    const mod = await import("@workspace/integrations-openai-ai-server");
    envClient = mod.openai;
  }
  return envClient;
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
      const vaultKey = creds?.api_key?.trim();
      let client: any;
      if (vaultKey) {
        const OpenAI = (await import("openai")).default;
        client = new OpenAI({ apiKey: vaultKey });
      } else {
        client = await getEnvClient();
      }

      const model = req.model || openaiAdapter.defaultModel;
      const messages: Array<{ role: "system" | "user"; content: any }> = [];
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
    } catch (err: any) {
      const status = err?.status ?? 0;
      logger.error({ err, status, provider: "openai" }, "openai complete failed");
      return {
        ok: false,
        retryable: status === 429 || status >= 500,
        code: status ? `http_${status}` : "sdk_error",
        message: String(err?.message ?? err),
      };
    }
  },
};
