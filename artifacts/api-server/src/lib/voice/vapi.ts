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
import type { VoiceAdapter, VoiceListOutcome, VoiceCallOutcome } from "./types";

export const vapiVoiceAdapter: VoiceAdapter = {
  provider: "vapi",

  async startCall(creds, req): Promise<VoiceCallOutcome> {
    const apiKey = creds.api_key?.trim();
    if (!apiKey) return { ok: false, retryable: false, code: "no_api_key", message: "Vapi api_key missing" };
    const cfg = (creds.config && typeof creds.config === "object" ? creds.config : {}) as Record<string, unknown>;
    const phoneNumberId = typeof cfg.phone_number_id === "string" ? cfg.phone_number_id : undefined;
    const payload: Record<string, unknown> = {
      assistantId: req.assistantId,
      customer: { number: req.to },
    };
    if (phoneNumberId) payload.phoneNumberId = phoneNumberId;
    if (req.context) payload.assistantOverrides = { variableValues: req.context };
    if (req.metadata) payload.metadata = req.metadata;
    let resp: Response;
    try {
      resp = await fetch("https://api.vapi.ai/call", {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
    } catch (err) {
      logger.error({ err, provider: "vapi" }, "vapi startCall network error");
      return { ok: false, retryable: true, code: "network_error", message: String((err as Error).message) };
    }
    const json = (await resp.json().catch(() => ({}))) as { id?: string };
    if (!resp.ok || !json?.id) {
      const body = JSON.stringify(json).slice(0, 200);
      return {
        ok: false,
        retryable: resp.status === 429 || resp.status >= 500,
        code: `http_${resp.status}`,
        message: `vapi startCall: HTTP ${resp.status} ${body}`,
      };
    }
    return { ok: true, externalCallId: String(json.id), rawResponse: json };
  },

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
