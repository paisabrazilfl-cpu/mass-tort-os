import type { FaxAdapter } from "./types";
import { telnyxFaxAdapter } from "./telnyx";

export * from "./types";

const ADAPTERS: Record<string, FaxAdapter> = {
  [telnyxFaxAdapter.provider]: telnyxFaxAdapter,
};

export function getFaxAdapter(provider: string): FaxAdapter | null {
  return ADAPTERS[provider] || null;
}

export function listFaxProviders(): string[] {
  return Object.keys(ADAPTERS);
}
