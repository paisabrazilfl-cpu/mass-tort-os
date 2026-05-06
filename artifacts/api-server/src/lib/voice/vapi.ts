/**
 * Vapi VoiceAdapter shape used by lib/voice/index.ts and the workflow
 * Voice provider router (`listAssistants` + verify scripts).
 *
 * NOTE: Webhook signature verification + tool-bearer auth used to live
 * here, but those helpers depend on routes/integrations which depends
 * back on integration-wiring and lib/voice — a real import cycle that
 * TDZ-traps the adapter. They now live in `./vapi-webhook.ts`, which
 * is only loaded by request-handlers (no boot-time cycle).
 */
import { logger } from "../logger";
import type { VoiceAdapter, VoiceListOutcome } from "./types";

export const vapiVoiceAdapter: VoiceAdapter = {
  provider: "vapi",
  async listAssistants(creds): Promise<VoiceListOutcome> {
    const apiKey = creds.api_key?.trim();
    if (!apiKey) return { ok: false, retryable: false, code: "no_api_key", message: "Vapi api_key missing" };
    let resp: Response;
    try {
      resp = await fetch("https://api.vapi.ai/assistant?limit=10", {
        headers: { Authorization: `Bearer ${apiKey}` },
      });
    } catch (err) {
      logger.error({ err, provider: "vapi" }, "vapi network error");
      return { ok: false, retryable: true, code: "network_error", message: String((err as Error).message) };
    }
    if (!resp.ok) {
      const body = await resp.text().catch(() => "");
      return {
        ok: false,
        retryable: resp.status === 429 || resp.status >= 500,
        code: `http_${resp.status}`,
        message: `vapi: HTTP ${resp.status} ${body.slice(0, 200)}`,
      };
    }
    const json: any = await resp.json().catch(() => ([]));
    const list: any[] = Array.isArray(json) ? json : json?.items ?? [];
    return {
      ok: true,
      assistants: list.map((a: any) => ({ id: String(a?.id ?? ""), name: a?.name })),
      rawResponse: json,
    };
  },
};

// NOTE: webhook helpers (loadVapiCredentials, verifyVapiSignature,
// verifyVapiToolBearer) live in ./vapi-webhook and must be imported
// from there directly. Re-exporting them here would re-introduce the
// boot-time import cycle through routes/integrations.
