/**
 * Common interface every voice-AI adapter must implement.
 * The primary action right now is "list assistants" used by verifiers
 * and the integration health checks; outbound dial is provider-specific
 * and lives in dedicated routes.
 */
import type { DecryptedCredentials } from "../../routes/integrations";

export interface VoiceAssistantSummary {
  id: string;
  name?: string;
}

export interface VoiceListResult {
  ok: true;
  assistants: VoiceAssistantSummary[];
  rawResponse?: unknown;
}

export interface VoiceError {
  ok: false;
  retryable: boolean;
  code: string;
  message: string;
}

export type VoiceListOutcome = VoiceListResult | VoiceError;

// ─────────────────────────────────────────────────────────────────
// Outbound dial — workflow handlers / lead-callback nodes use this
// shape to ask the configured voice provider to start a call. Each
// adapter maps the request onto its own assistant/agent + phone API.
// ─────────────────────────────────────────────────────────────────

export interface VoiceCallRequest {
  to: string;                       // E.164 destination
  from?: string;                    // optional caller-id override
  assistantId: string;              // provider-side agent/assistant id
  metadata?: Record<string, string>;
  /**
   * Provider-agnostic context object the assistant can reference
   * (lead first name, tort, qualifying questions, etc). Each adapter
   * is responsible for forwarding only the keys its API supports.
   */
  context?: Record<string, unknown>;
}

export interface VoiceCallResult {
  ok: true;
  externalCallId: string;
  rawResponse?: unknown;
}

export type VoiceCallOutcome = VoiceCallResult | VoiceError;

export interface VoiceAdapter {
  provider: string;
  listAssistants(creds: DecryptedCredentials): Promise<VoiceListOutcome>;
  /**
   * Start an outbound call. The adapter MUST persist any state the
   * provider returns (call id, status webhook URL, etc) by returning
   * `externalCallId`; correlation back to MTOS lead/firm context is
   * the caller's responsibility via `metadata` / `context`.
   */
  startCall(creds: DecryptedCredentials, req: VoiceCallRequest): Promise<VoiceCallOutcome>;
}
