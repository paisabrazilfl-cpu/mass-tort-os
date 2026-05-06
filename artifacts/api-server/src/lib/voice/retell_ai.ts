import type { VoiceAdapter, VoiceListOutcome, VoiceCallOutcome } from "./types";
import { logger } from "../logger";

/**
 * Retell AI voice adapter. https://docs.retellai.com/api-references/list-agents
 */
export const retellAiAdapter: VoiceAdapter = {
  provider: "retell_ai",

  async startCall(creds, req): Promise<VoiceCallOutcome> {
    const apiKey = creds.api_key?.trim();
    if (!apiKey) return { ok: false, retryable: false, code: "no_api_key", message: "Retell api_key missing" };
    const cfg = (creds.config && typeof creds.config === "object" ? creds.config : {}) as Record<string, unknown>;
    const fromNumber = req.from
      ?? (typeof cfg.from_number === "string" ? cfg.from_number : undefined);
    if (!fromNumber) {
      return { ok: false, retryable: false, code: "no_from_number", message: "Retell requires config.from_number or req.from." };
    }
    const payload: Record<string, unknown> = {
      from_number: fromNumber,
      to_number: req.to,
      override_agent_id: req.assistantId,
    };
    if (req.context) payload.retell_llm_dynamic_variables = req.context;
    if (req.metadata) payload.metadata = req.metadata;
    let resp: Response;
    try {
      resp = await fetch("https://api.retellai.com/v2/create-phone-call", {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
    } catch (err) {
      logger.error({ err, provider: "retell_ai" }, "retell startCall network error");
      return { ok: false, retryable: true, code: "network_error", message: String((err as Error).message) };
    }
    const json: { call_id?: string } = await resp.json().catch(() => ({}));
    if (!resp.ok || !json?.call_id) {
      return {
        ok: false,
        retryable: resp.status === 429 || resp.status >= 500,
        code: `http_${resp.status}`,
        message: `retell startCall: HTTP ${resp.status}`,
      };
    }
    return { ok: true, externalCallId: String(json.call_id), rawResponse: json };
  },

  async listAssistants(creds): Promise<VoiceListOutcome> {
    const apiKey = creds.api_key?.trim();
    if (!apiKey) return { ok: false, retryable: false, code: "no_api_key", message: "Retell api_key missing" };
    let resp: Response;
    try {
      resp = await fetch("https://api.retellai.com/list-agents", {
        headers: { Authorization: `Bearer ${apiKey}` },
      });
    } catch (err) {
      logger.error({ err, provider: "retell_ai" }, "retell network error");
      return { ok: false, retryable: true, code: "network_error", message: String((err as Error).message) };
    }
    if (!resp.ok) {
      const body = await resp.text().catch(() => "");
      return {
        ok: false,
        retryable: resp.status === 429 || resp.status >= 500,
        code: `http_${resp.status}`,
        message: `retell: HTTP ${resp.status} ${body.slice(0, 200)}`,
      };
    }
    const json: any = await resp.json().catch(() => ([]));
    const list: any[] = Array.isArray(json) ? json : json?.agents ?? [];
    return {
      ok: true,
      assistants: list.map((a: any) => ({ id: String(a?.agent_id ?? a?.id ?? ""), name: a?.agent_name ?? a?.name })),
      rawResponse: json,
    };
  },
};
