import type { FaxAdapter } from "./types";
import { srfaxAdapter } from "./srfax";

export * from "./types";

const ADAPTERS: Record<string, FaxAdapter> = {
  [srfaxAdapter.provider]: srfaxAdapter,
};

export function getFaxAdapter(provider: string): FaxAdapter | null {
  return ADAPTERS[provider] || null;
}

export function listFaxProviders(): string[] {
  return Object.keys(ADAPTERS);
}
