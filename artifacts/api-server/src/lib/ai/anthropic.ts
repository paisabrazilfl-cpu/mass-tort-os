import type { LlmAdapter, LlmCompletionOutcome } from "./types";
import { logger } from "../logger";
import type { Message } from "@anthropic-ai/sdk/resources/index.js";

type AnthropicCtor = typeof import("@anthropic-ai/sdk").default;
let envClient: InstanceType<AnthropicCtor> | undefined;

async function getEnvClient(): Promise<InstanceType<AnthropicCtor>> {
  if (!envClient) {
    const { default: Anthropic } = await import("@anthropic-ai/sdk");
    envClient = new Anthropic({
      apiKey: process.env.AI_INTEGRATIONS_ANTHROPIC_API_KEY,
      baseURL: process.env.AI_INTEGRATIONS_ANTHROPIC_BASE_URL,
    });
  }
  return envClient;
}

/**
 * Anthropic adapter — uses the operator's vault api_key when present,
 * otherwise falls back to the Replit AI Integrations env-managed client
 * (envManaged=true). This is the system-wide hard fallback when a chosen
 * provider returns a non-retryable error.
 */
export const anthropicAdapter: LlmAdapter = {
  provider: "anthropic",
  defaultModel: "claude-haiku-4-5",
  envManaged: true,

  async complete(creds, req): Promise<LlmCompletionOutcome> {
    try {
      let client: InstanceType<AnthropicCtor>;
      const vaultKey = creds?.api_key?.trim();
      if (vaultKey) {
        const { default: Anthropic } = await import("@anthropic-ai/sdk");
        client = new Anthropic({ apiKey: vaultKey });
      } else {
        client = await getEnvClient();
      }

      const model = req.model || anthropicAdapter.defaultModel;
      type AnthropicContent = Parameters<typeof client.messages.create>[0]["messages"][0]["content"];
      let content: AnthropicContent;
      if (req.imageBase64 && req.imageMimeType) {
        content = [
          { type: "image", source: { type: "base64", media_type: req.imageMimeType, data: req.imageBase64 } },
          { type: "text", text: req.prompt },
        ];
      } else {
        content = req.prompt;
      }
      const params: Parameters<typeof client.messages.create>[0] = {
        model,
        max_tokens: req.maxTokens,
        messages: [{ role: "user", content }],
      };
      if (req.systemPrompt) params.system = req.systemPrompt;

      const response = (await client.messages.create(params)) as Message;
      const block = response.content[0];
      const text = block?.type === "text" ? block.text : "";
      return {
        ok: true,
        text,
        model,
        usage: {
          input_tokens: response.usage?.input_tokens,
          output_tokens: response.usage?.output_tokens,
        },
      };
    } catch (err: unknown) {
      const status = (err as { status?: number })?.status ?? 0;
      logger.error({ err, status, provider: "anthropic" }, "anthropic complete failed");
      return {
        ok: false,
        retryable: status === 429 || status >= 500,
        code: status ? `http_${status}` : "sdk_error",
        message: err instanceof Error ? err.message : String(err),
      };
    }
  },

  /**
   * Native multi-turn chat: maps the normalized turns onto Anthropic's
   * { system, messages: [{role, content}] } shape so context is
   * preserved across turns without the runChat() prompt-flattening
   * fallback.
   */
  async chat(creds, req): Promise<LlmCompletionOutcome> {
    try {
      let client: InstanceType<AnthropicCtor>;
      const vaultKey = creds?.api_key?.trim();
      if (vaultKey) {
        const { default: Anthropic } = await import("@anthropic-ai/sdk");
        client = new Anthropic({ apiKey: vaultKey });
      } else {
        client = await getEnvClient();
      }
      const model = req.model || anthropicAdapter.defaultModel;
      const systemTurns = req.messages.filter((m) => m.role === "system").map((m) => m.content).join("\n\n");
      const turns = req.messages
        .filter((m) => m.role !== "system")
        .map((m) => ({ role: m.role as "user" | "assistant", content: m.content }));
      const params: Parameters<typeof client.messages.create>[0] = {
        model,
        max_tokens: req.maxTokens,
        messages: turns,
      };
      if (systemTurns) params.system = systemTurns;
      const response = (await client.messages.create(params)) as Message;
      const block = response.content[0];
      const text = block?.type === "text" ? block.text : "";
      return {
        ok: true,
        text,
        model,
        usage: {
          input_tokens: response.usage?.input_tokens,
          output_tokens: response.usage?.output_tokens,
        },
      };
    } catch (err: unknown) {
      const status = (err as { status?: number })?.status ?? 0;
      logger.error({ err, status, provider: "anthropic" }, "anthropic chat failed");
      return {
        ok: false,
        retryable: status === 429 || status >= 500,
        code: status ? `http_${status}` : "sdk_error",
        message: err instanceof Error ? err.message : String(err),
      };
    }
  },
};
