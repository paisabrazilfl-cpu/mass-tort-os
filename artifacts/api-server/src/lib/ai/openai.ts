import type { LlmAdapter, LlmCompletionOutcome, LlmEmbedOutcome } from "./types";
import { logger } from "../logger";

// The `openai` SDK isn't a direct workspace dep — we reach it through
// the Replit AI integrations env wrapper. Both the env-managed client
// and an operator-vault-keyed client expose the same chat.completions
// surface, so we model both as the env wrapper's `openai` type.
type OpenAIModule = typeof import("@workspace/integrations-openai-ai-server");
type OpenAIClient = OpenAIModule["openai"];
type ChatMessage = Parameters<OpenAIClient["chat"]["completions"]["create"]>[0]["messages"][number];
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
      let client: OpenAIClient;
      if (vaultKey) {
        // Construct a fresh client from the env wrapper's underlying SDK
        // but rebound to the operator's vault key. We read the OpenAI
        // class off the env client's prototype to avoid a hard dep on the
        // `openai` package (it isn't in @workspace/api-server's deps).
        const env = await getEnvClient();
        const OpenAICtor = (env.constructor as new (opts: { apiKey: string }) => OpenAIClient);
        client = new OpenAICtor({ apiKey: vaultKey });
      } else {
        client = await getEnvClient();
      }

      const model = req.model || openaiAdapter.defaultModel;
      const messages: ChatMessage[] = [];
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

  /**
   * Native chat surface: forwards messages directly to OpenAI's
   * chat.completions endpoint without the prompt-flattening fallback,
   * so multi-turn callers see proper context retention.
   */
  async chat(creds, req): Promise<LlmCompletionOutcome> {
    try {
      const vaultKey = typeof creds?.api_key === "string" ? creds.api_key.trim() : "";
      const env = await getEnvClient();
      const client: OpenAIClient = vaultKey
        ? new (env.constructor as new (opts: { apiKey: string }) => OpenAIClient)({ apiKey: vaultKey })
        : env;
      const model = req.model || openaiAdapter.defaultModel;
      const messages: ChatMessage[] = req.messages.map((m) => ({ role: m.role, content: m.content })) as ChatMessage[];
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
      logger.error({ err, status, provider: "openai" }, "openai chat failed");
      return {
        ok: false,
        retryable: status === 429 || status >= 500,
        code: status ? `http_${status}` : "sdk_error",
        message: String(e?.message ?? err),
      };
    }
  },

  /**
   * Native embeddings (text-embedding-3-* family). Falls back to the
   * env wrapper when no vault key is set. The OpenAI SDK has an
   * `embeddings.create` surface on the same client used for chat.
   */
  async embed(creds, req): Promise<LlmEmbedOutcome> {
    try {
      const vaultKey = typeof creds?.api_key === "string" ? creds.api_key.trim() : "";
      const env = await getEnvClient();
      const client = vaultKey
        ? new (env.constructor as new (opts: { apiKey: string }) => OpenAIClient)({ apiKey: vaultKey })
        : env;
      const model = req.model || "text-embedding-3-small";
      // The env wrapper's typed surface is narrowed to chat; the
      // underlying SDK exposes embeddings on the same instance.
      const embeddings = (client as unknown as {
        embeddings: { create: (p: { model: string; input: string[] }) => Promise<{
          data: Array<{ embedding: number[] }>;
          usage?: { prompt_tokens?: number };
        }> };
      }).embeddings;
      const response = await embeddings.create({ model, input: req.inputs });
      return {
        ok: true,
        model,
        vectors: response.data.map((d) => d.embedding),
        usage: { input_tokens: response.usage?.prompt_tokens },
      };
    } catch (err) {
      const e = err as OpenAIErrorShape;
      const status = e?.status ?? 0;
      logger.error({ err, status, provider: "openai" }, "openai embed failed");
      return {
        ok: false,
        retryable: status === 429 || status >= 500,
        code: status ? `http_${status}` : "sdk_error",
        message: String(e?.message ?? err),
      };
    }
  },
};
