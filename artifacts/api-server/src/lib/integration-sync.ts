/**
 * Per-provider sync handler registry. The original /integrations/:id/sync
 * route was an honest stub for every provider — it returned
 * `success: false, implemented: false`, which is technically correct but
 * surfaced a button that did nothing for every customer that clicked it.
 *
 * This registry is the contract: a provider is "syncable" iff its key is
 * present here. The route delegates to the handler; if none is registered
 * the route returns HTTP 501 (Not Implemented) with a machine-readable
 * envelope so the UI can hide / disable the button rather than offering
 * an action that's guaranteed to do nothing.
 *
 * Add a new sync handler:
 *   1. Implement `(integration) => Promise<SyncOutcome>` in the relevant lib.
 *   2. Register it below.
 *   3. The /integrations/categories endpoint and the wiring map in
 *      lib/integration-wiring.ts already track which providers are wired;
 *      this is a SEPARATE registry because "has live adapter code" is
 *      not the same question as "supports a pull-style sync."
 */
import { integrationsTable } from "@workspace/db";
import { logger } from "./logger";

// The integrations schema doesn't export a row-type alias, so we derive one
// from the Drizzle table definition. Same shape as `db.select().from(integrationsTable)`
// gives back, so handlers can take the whole row without further mapping.
export type IntegrationRow = typeof integrationsTable.$inferSelect;

export interface SyncOutcome {
  ok: boolean;
  records_synced: number;
  direction: "pull" | "push" | "bidirectional";
  details?: Record<string, unknown>;
  error?: string;
}

export type SyncHandler = (integration: IntegrationRow) => Promise<SyncOutcome>;

const HANDLERS = new Map<string, SyncHandler>();

export function registerSyncHandler(provider: string, handler: SyncHandler): void {
  if (HANDLERS.has(provider)) {
    logger.warn({ provider }, "integration-sync: handler re-registered (replacing)");
  }
  HANDLERS.set(provider, handler);
}

export function getSyncHandler(provider: string): SyncHandler | null {
  return HANDLERS.get(provider) ?? null;
}

export function supportsSync(provider: string): boolean {
  return HANDLERS.has(provider);
}

export function listSyncableProviders(): string[] {
  return [...HANDLERS.keys()].sort();
}

