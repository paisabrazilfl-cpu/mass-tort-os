import type { EsignAdapter } from "./types";
import { dropboxSignAdapter } from "./dropbox-sign";
import { docusignAdapter } from "./docusign";

export * from "./types";

/**
 * Registry of every wired e-sign adapter, keyed by integration provider id.
 * To add a new provider: write a new adapter implementing EsignAdapter,
 * then register it here. No other code changes needed.
 */
const ADAPTERS: Record<string, EsignAdapter> = {
  [dropboxSignAdapter.provider]: dropboxSignAdapter,
  [docusignAdapter.provider]: docusignAdapter,
};

export function getEsignAdapter(provider: string): EsignAdapter | null {
  return ADAPTERS[provider] || null;
}

export function listEsignProviders(): string[] {
  return Object.keys(ADAPTERS);
}
