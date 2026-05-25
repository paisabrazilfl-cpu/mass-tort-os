import type { LlmAdapter, LlmCompletionOutcome, LlmEmbedOutcome } from "./types";
import { logger } from "../logger";

/**
 * Cohere v2 chat adapter. https://docs.cohere.com/reference/chat
 * Cohere uses {messages:[{role,content}]} but the response shape is
 * different from OpenAI's, so we hand-roll the call instead of reusing
 * the openAiCompatChat helper.
 */
export const cohereAdapter: LlmAdapter = {
  provider: "cohere",
  defaultModel: "command-r-plus",

  async complete(creds, req): Promise<LlmCompletionOutcome> {
    const apiKey = creds?.api_key?.trim();
    if (!apiKey) return { ok: false, retryable: false, code: "no_api_key", message: "Cohere api_key missing" };

    const model = req.model || cohereAdapter.defaultModel;
    const messages: Array<{ role: "system" | "user"; content: string }> = [];
    if (req.systemPrompt) messages.push({ role: "system", content: req.systemPrompt });
    messages.push({ role: "user", content: req.prompt });

    let resp: Response;
    try {
      resp = await fetch("https://api.cohere.com/v2/chat", {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ model, messages, max_tokens: req.maxTokens }),
      });
    } catch (err) {
      logger.error({ err, provider: "cohere" }, "cohere network error");
      return { ok: false, retryable: true, code: "network_error", message: String((err as Error).message) };
    }
    if (!resp.ok) {
      const body = await resp.text().catch(() => "");
      return {
        ok: false,
        retryable: resp.status === 429 || resp.status >= 500,
        code: `http_${resp.status}`,
        message: `cohere: HTTP ${resp.status} ${body.slice(0, 200)}`,
      };
    }
    const json: any = await resp.json().catch(() => ({}));
    const text = json?.message?.content?.[0]?.text ?? "";
    return {
      ok: true,
      text,
      model,
      usage: {
        input_tokens: json?.usage?.tokens?.input_tokens,
        output_tokens: json?.usage?.tokens?.output_tokens,
      },
    };
  },

  /**
   * Cohere's embeddings v2 API. Cohere's reranker + embeddings is the
   * stated reason this adapter is in the registry per Task #67 spec
   * (RAG over case files); we expose it here so callers can hit the
   * uniform LlmAdapter.embed contract.
   */
  async embed(creds, req): Promise<LlmEmbedOutcome> {
    const apiKey = creds?.api_key?.trim();
    if (!apiKey) return { ok: false, retryable: false, code: "no_api_key", message: "Cohere api_key missing" };
    const model = req.model || "embed-english-v3.0";
    let resp: Response;
    try {
      resp = await fetch("https://api.cohere.com/v2/embed", {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          model,
          texts: req.inputs,
          input_type: "search_document",
          embedding_types: ["float"],
        }),
      });
    } catch (err) {
      logger.error({ err, provider: "cohere" }, "cohere embed network error");
      return { ok: false, retryable: true, code: "network_error", message: String((err as Error).message) };
    }
    if (!resp.ok) {
      const body = await resp.text().catch(() => "");
      return {
        ok: false,
        retryable: resp.status === 429 || resp.status >= 500,
        code: `http_${resp.status}`,
        message: `cohere embed: HTTP ${resp.status} ${body.slice(0, 200)}`,
      };
    }
    const json: any = await resp.json().catch(() => ({}));
    const vectors: number[][] = json?.embeddings?.float ?? json?.embeddings ?? [];
    return {
      ok: true,
      model,
      vectors,
      usage: { input_tokens: json?.meta?.billed_units?.input_tokens },
    };
  },
};
