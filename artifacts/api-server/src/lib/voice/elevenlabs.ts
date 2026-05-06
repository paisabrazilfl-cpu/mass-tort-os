import type { VoiceAdapter, VoiceListOutcome, VoiceCallOutcome } from "./types";
import { logger } from "../logger";

/**
 * ElevenLabs Conversational AI adapter.
 * https://elevenlabs.io/docs/conversational-ai/api-reference/agents/get-agents
 * Auth: xi-api-key header.
 */
export const elevenlabsAdapter: VoiceAdapter = {
  provider: "elevenlabs",

  async startCall(creds, req): Promise<VoiceCallOutcome> {
    const apiKey = creds.api_key?.trim();
    if (!apiKey) return { ok: false, retryable: false, code: "no_api_key", message: "ElevenLabs api_key missing" };
    const cfg = (creds.config && typeof creds.config === "object" ? creds.config : {}) as Record<string, unknown>;
    const phoneNumberId = typeof cfg.phone_number_id === "string" ? cfg.phone_number_id : undefined;
    if (!phoneNumberId) {
      return { ok: false, retryable: false, code: "no_phone_number_id", message: "ElevenLabs requires config.phone_number_id." };
    }
    const payload: Record<string, unknown> = {
      agent_id: req.assistantId,
      agent_phone_number_id: phoneNumberId,
      to_number: req.to,
    };
    if (req.context) payload.conversation_initiation_client_data = { dynamic_variables: req.context };
    let resp: Response;
    try {
      resp = await fetch("https://api.elevenlabs.io/v1/convai/twilio/outbound-call", {
        method: "POST",
        headers: { "xi-api-key": apiKey, "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
    } catch (err) {
      logger.error({ err, provider: "elevenlabs" }, "elevenlabs startCall network error");
      return { ok: false, retryable: true, code: "network_error", message: String((err as Error).message) };
    }
    const json: { conversation_id?: string; callSid?: string } = await resp.json().catch(() => ({}));
    const externalId = json.conversation_id ?? json.callSid;
    if (!resp.ok || !externalId) {
      return {
        ok: false,
        retryable: resp.status === 429 || resp.status >= 500,
        code: `http_${resp.status}`,
        message: `elevenlabs startCall: HTTP ${resp.status}`,
      };
    }
    return { ok: true, externalCallId: String(externalId), rawResponse: json };
  },

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
