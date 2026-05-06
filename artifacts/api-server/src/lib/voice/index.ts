import type { VoiceAdapter } from "./types";
import { vapiVoiceAdapter } from "./vapi";
import { retellAiAdapter } from "./retell_ai";
import { blandAiAdapter } from "./bland_ai";
import { elevenlabsAdapter } from "./elevenlabs";
import { synthflowAdapter } from "./synthflow";

export * from "./types";

/**
 * Lazy registry to break the import cycle:
 *   voice/vapi.ts → routes/integrations → lib/integration-wiring → lib/voice/index.ts
 *
 * If we built ADAPTERS at top level, the `.provider` access on the
 * imported consts would TDZ-trap when the cycle re-enters voice/index
 * mid-vapi-init. We hold off touching the imports until first call.
 */
let _registry: Record<string, VoiceAdapter> | null = null;
function getRegistry(): Record<string, VoiceAdapter> {
  if (_registry) return _registry;
  _registry = {
    [vapiVoiceAdapter.provider]: vapiVoiceAdapter,
    [retellAiAdapter.provider]: retellAiAdapter,
    [blandAiAdapter.provider]: blandAiAdapter,
    [elevenlabsAdapter.provider]: elevenlabsAdapter,
    [synthflowAdapter.provider]: synthflowAdapter,
  };
  return _registry;
}

export function getVoiceAdapter(provider: string): VoiceAdapter | null {
  return getRegistry()[provider] || null;
}

export function listVoiceProviders(): string[] {
  return Object.keys(getRegistry());
}
