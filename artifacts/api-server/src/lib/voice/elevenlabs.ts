import type { VoiceAdapter, VoiceListOutcome } from "./types";
import { logger } from "../logger";

/**
 * ElevenLabs Conversational AI adapter.
 * https://elevenlabs.io/docs/conversational-ai/api-reference/agents/get-agents
 * Auth: xi-api-key header.
 */
export const elevenlabsAdapter: VoiceAdapter = {
  provider: "elevenlabs",

  async listAssistants(creds): Promise<VoiceListOutcome> {
    const apiKey = creds.api_key?.trim();
    if (!apiKey) return { ok: false, retryable: false, code: "no_api_key", message: "ElevenLabs api_key missing" };
    let resp: Response;
    try {
      resp = await fetch("https://api.elevenlabs.io/v1/convai/agents", { headers: { "xi-api-key": apiKey } });
    } catch (err) {
      logger.error({ err, provider: "elevenlabs" }, "elevenlabs network error");
      return { ok: false, retryable: true, code: "network_error", message: String((err as Error).message) };
    }
    if (!resp.ok) {
      // some accounts only have voices, not agents — fall back so the
      // verifier can still confirm the api_key is valid.
      try {
        const voicesResp = await fetch("https://api.elevenlabs.io/v1/voices", { headers: { "xi-api-key": apiKey } });
        if (voicesResp.ok) {
          const j: any = await voicesResp.json().catch(() => ({}));
          const list: any[] = j?.voices ?? [];
          return {
            ok: true,
            assistants: list.slice(0, 10).map((v: any) => ({ id: String(v?.voice_id ?? ""), name: v?.name })),
            rawResponse: j,
          };
        }
      } catch { /* fall through */ }
      const body = await resp.text().catch(() => "");
      return {
        ok: false,
        retryable: resp.status === 429 || resp.status >= 500,
        code: `http_${resp.status}`,
        message: `elevenlabs: HTTP ${resp.status} ${body.slice(0, 200)}`,
      };
    }
    const json: any = await resp.json().catch(() => ({}));
    const list: any[] = json?.agents ?? [];
    return {
      ok: true,
      assistants: list.map((a: any) => ({ id: String(a?.agent_id ?? ""), name: a?.name })),
      rawResponse: json,
    };
  },
};
