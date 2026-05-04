import type { FaxAdapter } from "./types";

export * from "./types";

const ADAPTERS: Record<string, FaxAdapter> = {};

export function getFaxAdapter(provider: string): FaxAdapter | null {
  return ADAPTERS[provider] || null;
}

export function listFaxProviders(): string[] {
  return Object.keys(ADAPTERS);
}
