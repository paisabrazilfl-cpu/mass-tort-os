import type { VoiceAdapter, VoiceListOutcome } from "./types";
import { logger } from "../logger";

/**
 * Retell AI voice adapter. https://docs.retellai.com/api-references/list-agents
 */
export const retellAiAdapter: VoiceAdapter = {
  provider: "retell_ai",

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
