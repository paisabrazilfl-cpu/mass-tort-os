import type { SearchAdapter } from "./types";
import { serpapiAdapter } from "./serpapi";

export * from "./types";

// Lazy registry — see lib/voice/index.ts for the cycle-breaking rationale.
let _registry: Record<string, SearchAdapter> | null = null;
function getRegistry(): Record<string, SearchAdapter> {
  if (_registry) return _registry;
  _registry = {
    [serpapiAdapter.provider]: serpapiAdapter,
  };
  return _registry;
}

export function getSearchAdapter(provider: string): SearchAdapter | null {
  return getRegistry()[provider] || null;
}

export function listSearchProviders(): string[] {
  return Object.keys(getRegistry());
}
