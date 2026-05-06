import type { LlmAdapter, LlmCompletionOutcome } from "./types";
import { logger } from "../logger";

/**
 * Google Gemini adapter using the v1beta REST API.
 * https://ai.google.dev/api/generate-content
 */
export const googleGeminiAdapter: LlmAdapter = {
  provider: "google_gemini",
  defaultModel: "gemini-2.5-flash",

  async complete(creds, req): Promise<LlmCompletionOutcome> {
    const apiKey = creds?.api_key?.trim();
    if (!apiKey) return { ok: false, retryable: false, code: "no_api_key", message: "Gemini api_key missing" };

    const model = req.model || googleGeminiAdapter.defaultModel;
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;

    const parts: any[] = [{ text: req.prompt }];
    if (req.imageBase64 && req.imageMimeType) {
      parts.unshift({ inline_data: { mime_type: req.imageMimeType, data: req.imageBase64 } });
    }
    const payload: any = {
      contents: [{ role: "user", parts }],
      generationConfig: { maxOutputTokens: req.maxTokens },
    };
    if (req.systemPrompt) payload.systemInstruction = { role: "system", parts: [{ text: req.systemPrompt }] };
    if (req.temperature !== undefined) payload.generationConfig.temperature = req.temperature;

    let resp: Response;
    try {
      resp = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
    } catch (err) {
      logger.error({ err, provider: "google_gemini" }, "gemini network error");
      return { ok: false, retryable: true, code: "network_error", message: String((err as Error).message) };
    }

    if (!resp.ok) {
      const body = await resp.text().catch(() => "");
      return {
        ok: false,
        retryable: resp.status === 429 || resp.status >= 500,
        code: `http_${resp.status}`,
        message: `gemini: HTTP ${resp.status} ${body.slice(0, 200)}`,
      };
    }

    const json: any = await resp.json().catch(() => ({}));
    const text = json?.candidates?.[0]?.content?.parts?.map((p: any) => p?.text ?? "").join("") ?? "";
    return {
      ok: true,
      text,
      model,
      usage: {
        input_tokens: json?.usageMetadata?.promptTokenCount,
        output_tokens: json?.usageMetadata?.candidatesTokenCount,
      },
    };
  },
};
