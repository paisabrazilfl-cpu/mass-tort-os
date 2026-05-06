import type { VoiceAdapter, VoiceListOutcome, VoiceCallOutcome } from "./types";
import { logger } from "../logger";

/**
 * Bland AI voice adapter. https://docs.bland.ai
 * Auth: api key in `authorization` header (no Bearer prefix).
 */
export const blandAiAdapter: VoiceAdapter = {
  provider: "bland_ai",

  async startCall(creds, req): Promise<VoiceCallOutcome> {
    const apiKey = creds.api_key?.trim();
    if (!apiKey) return { ok: false, retryable: false, code: "no_api_key", message: "Bland api_key missing" };
    const payload: Record<string, unknown> = {
      phone_number: req.to,
      pathway_id: req.assistantId,
    };
    if (req.from) payload.from = req.from;
    if (req.context) payload.request_data = req.context;
    if (req.metadata) payload.metadata = req.metadata;
    let resp: Response;
    try {
      resp = await fetch("https://api.bland.ai/v1/calls", {
        method: "POST",
        headers: { authorization: apiKey, "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
    } catch (err) {
      logger.error({ err, provider: "bland_ai" }, "bland startCall network error");
      return { ok: false, retryable: true, code: "network_error", message: String((err as Error).message) };
    }
    const json = (await resp.json().catch(() => ({}))) as { call_id?: string; status?: string };
    if (!resp.ok || !json?.call_id) {
      return {
        ok: false,
        retryable: resp.status === 429 || resp.status >= 500,
        code: `http_${resp.status}`,
        message: `bland startCall: HTTP ${resp.status}`,
      };
    }
    return { ok: true, externalCallId: String(json.call_id), rawResponse: json };
  },

  async listAssistants(creds): Promise<VoiceListOutcome> {
    const apiKey = creds.api_key?.trim();
    if (!apiKey) return { ok: false, retryable: false, code: "no_api_key", message: "Bland api_key missing" };
    let resp: Response;
    try {
      resp = await fetch("https://api.bland.ai/v1/pathway", { headers: { authorization: apiKey } });
    } catch (err) {
      logger.error({ err, provider: "bland_ai" }, "bland network error");
      return { ok: false, retryable: true, code: "network_error", message: String((err as Error).message) };
    }
    if (!resp.ok) {
      const body = await resp.text().catch(() => "");
      return {
        ok: false,
        retryable: resp.status === 429 || resp.status >= 500,
        code: `http_${resp.status}`,
        message: `bland: HTTP ${resp.status} ${body.slice(0, 200)}`,
      };
    }
    const json: any = await resp.json().catch(() => ([]));
    const list: any[] = Array.isArray(json) ? json : json?.pathways ?? [];
    return {
      ok: true,
      assistants: list.map((a: any) => ({ id: String(a?.id ?? a?.pathway_id ?? ""), name: a?.name })),
      rawResponse: json,
    };
  },
};
