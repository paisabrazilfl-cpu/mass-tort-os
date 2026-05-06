import type { SmsAdapter } from "./types";
import { twilioAdapter } from "./twilio";
import { telnyxSmsAdapter } from "./telnyx_adapter";
import { bandwidthAdapter } from "./bandwidth";
import { plivoAdapter } from "./plivo";
import { messagebirdAdapter } from "./messagebird";
import { sinchAdapter } from "./sinch";

export * from "./types";

// Lazy registry — see lib/voice/index.ts for the cycle-breaking rationale.
let _registry: Record<string, SmsAdapter> | null = null;
function getRegistry(): Record<string, SmsAdapter> {
  if (_registry) return _registry;
  _registry = {
    [twilioAdapter.provider]: twilioAdapter,
    [telnyxSmsAdapter.provider]: telnyxSmsAdapter,
    [bandwidthAdapter.provider]: bandwidthAdapter,
    [plivoAdapter.provider]: plivoAdapter,
    [messagebirdAdapter.provider]: messagebirdAdapter,
    [sinchAdapter.provider]: sinchAdapter,
  };
  return _registry;
}

export function getSmsAdapter(provider: string): SmsAdapter | null {
  return getRegistry()[provider] || null;
}

export function listSmsProviders(): string[] {
  return Object.keys(getRegistry());
}
