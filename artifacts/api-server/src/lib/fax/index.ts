import type { FaxAdapter } from "./types";
import { srfaxAdapter } from "./srfax";
import { efaxAdapter } from "./efax";
import { phaxioAdapter } from "./phaxio";
import { documoAdapter } from "./documo";
import { telnyxFaxAdapter } from "./telnyx_fax";

export * from "./types";

// Lazy registry — see lib/voice/index.ts for the cycle-breaking rationale.
let _registry: Record<string, FaxAdapter> | null = null;
function getRegistry(): Record<string, FaxAdapter> {
  if (_registry) return _registry;
  _registry = {
    [srfaxAdapter.provider]: srfaxAdapter,
    [efaxAdapter.provider]: efaxAdapter,
    [phaxioAdapter.provider]: phaxioAdapter,
    [documoAdapter.provider]: documoAdapter,
    [telnyxFaxAdapter.provider]: telnyxFaxAdapter,
  };
  return _registry;
}

export function getFaxAdapter(provider: string): FaxAdapter | null {
  return getRegistry()[provider] || null;
}

export function listFaxProviders(): string[] {
  return Object.keys(getRegistry());
}
