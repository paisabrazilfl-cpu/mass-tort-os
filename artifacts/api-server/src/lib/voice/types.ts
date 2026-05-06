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

export interface VoiceAdapter {
  provider: string;
  listAssistants(creds: DecryptedCredentials): Promise<VoiceListOutcome>;
}
