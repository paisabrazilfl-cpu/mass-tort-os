import type { VoiceAdapter, VoiceListOutcome, VoiceCallOutcome } from "./types";
import { logger } from "../logger";

/**
 * Synthflow voice adapter. https://docs.synthflow.ai
 * Auth: Bearer api_key.
 */
export const synthflowAdapter: VoiceAdapter = {
  provider: "synthflow",

  async startCall(creds, req): Promise<VoiceCallOutcome> {
    const apiKey = creds.api_key?.trim();
    if (!apiKey) return { ok: false, retryable: false, code: "no_api_key", message: "Synthflow api_key missing" };
    const payload: Record<string, unknown> = {
      model_id: req.assistantId,
      phone: req.to,
    };
    if (req.context) payload.variables = req.context;
    if (req.metadata) payload.metadata = req.metadata;
    let resp: Response;
    try {
      resp = await fetch("https://api.synthflow.ai/v2/calls", {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
    } catch (err) {
      logger.error({ err, provider: "synthflow" }, "synthflow startCall network error");
      return { ok: false, retryable: true, code: "network_error", message: String((err as Error).message) };
    }
    const json: { call_id?: string; response?: { call_id?: string } } = await resp.json().catch(() => ({}));
    const externalId = json.call_id ?? json.response?.call_id;
    if (!resp.ok || !externalId) {
      return {
        ok: false,
        retryable: resp.status === 429 || resp.status >= 500,
        code: `http_${resp.status}`,
        message: `synthflow startCall: HTTP ${resp.status}`,
      };
    }
    return { ok: true, externalCallId: String(externalId), rawResponse: json };
  },

  async listAssistants(creds): Promise<VoiceListOutcome> {
    const apiKey = creds.api_key?.trim();
    if (!apiKey) return { ok: false, retryable: false, code: "no_api_key", message: "Synthflow api_key missing" };
    let resp: Response;
    try {
      resp = await fetch("https://api.synthflow.ai/v2/assistants", {
        headers: { Authorization: `Bearer ${apiKey}` },
      });
    } catch (err) {
      logger.error({ err, provider: "synthflow" }, "synthflow network error");
      return { ok: false, retryable: true, code: "network_error", message: String((err as Error).message) };
    }
    if (!resp.ok) {
      const body = await resp.text().catch(() => "");
      return {
        ok: false,
        retryable: resp.status === 429 || resp.status >= 500,
        code: `http_${resp.status}`,
        message: `synthflow: HTTP ${resp.status} ${body.slice(0, 200)}`,
      };
    }
    const json: any = await resp.json().catch(() => ({}));
    const list: any[] = Array.isArray(json) ? json : json?.response?.assistants ?? json?.assistants ?? [];
    return {
      ok: true,
      assistants: list.map((a: any) => ({ id: String(a?.model_id ?? a?.id ?? ""), name: a?.name })),
      rawResponse: json,
    };
  },
};
