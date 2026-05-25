/**
 * Shared helper for OpenAI-compatible /chat/completions adapters
 * (Groq, DeepSeek, Perplexity, Mistral, xAI Grok, Fireworks, OpenRouter).
 *
 * One automatic retry on 429/5xx with 500ms back-off. Network errors are
 * surfaced as retryable. All other vendor errors are non-retryable so the
 * caller can fall back to Anthropic without thrashing.
 */
import { logger } from "../logger";
import type { LlmCompletionOutcome, LlmCompletionRequest } from "./types";

export interface OpenAiCompatOptions {
  provider: string;
  baseUrl: string;
  apiKey: string;
  defaultModel: string;
  /** Some providers (e.g. Anthropic-style) need a custom auth header. */
  buildHeaders?: (apiKey: string) => Record<string, string>;
}

export async function openAiCompatChat(
  opts: OpenAiCompatOptions,
  req: LlmCompletionRequest,
): Promise<LlmCompletionOutcome> {
  const model = req.model || opts.defaultModel;

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

  const payload: Record<string, unknown> = {
    model,
    messages,
    max_tokens: req.maxTokens,
  };
  if (req.temperature !== undefined) payload.temperature = req.temperature;

  const headers = opts.buildHeaders
    ? opts.buildHeaders(opts.apiKey)
    : { Authorization: `Bearer ${opts.apiKey}`, "Content-Type": "application/json" };

  const url = `${opts.baseUrl.replace(/\/+$/, "")}/chat/completions`;

  for (let attempt = 0; attempt < 2; attempt++) {
    let resp: Response;
    try {
      resp = await fetch(url, { method: "POST", headers, body: JSON.stringify(payload) });
    } catch (err) {
      if (attempt === 0) {
        await sleep(500);
        continue;
      }
      logger.error({ err, provider: opts.provider }, "LLM adapter network error");
      return { ok: false, retryable: true, code: "network_error", message: String((err as Error).message) };
    }

    if (resp.status === 429 || resp.status >= 500) {
      if (attempt === 0) {
        await sleep(500);
        continue;
      }
      const body = await resp.text().catch(() => "");
      return {
        ok: false,
        retryable: true,
        code: `http_${resp.status}`,
        message: `${opts.provider}: HTTP ${resp.status} ${body.slice(0, 200)}`,
      };
    }

    if (!resp.ok) {
      const body = await resp.text().catch(() => "");
      return {
        ok: false,
        retryable: false,
        code: `http_${resp.status}`,
        message: `${opts.provider}: HTTP ${resp.status} ${body.slice(0, 200)}`,
      };
    }

    const json: any = await resp.json().catch(() => ({}));
    const text = json?.choices?.[0]?.message?.content ?? "";
    if (typeof text !== "string") {
      return { ok: false, retryable: false, code: "bad_response", message: `${opts.provider}: missing message.content` };
    }
    return {
      ok: true,
      text,
      model,
      usage: json?.usage
        ? { input_tokens: json.usage.prompt_tokens, output_tokens: json.usage.completion_tokens }
        : undefined,
    };
  }

  return { ok: false, retryable: true, code: "exhausted", message: `${opts.provider}: retries exhausted` };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
