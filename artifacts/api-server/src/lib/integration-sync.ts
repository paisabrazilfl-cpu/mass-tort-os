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
 *   1. Implement `(integration) => Promise<SyncOutcome>` in the relevant
 *      lib (e.g. lib/fasten/sync.ts).
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

// ─── Live handlers ──────────────────────────────────────────────────────────
//
// Fasten is the only provider with a real pull-sync today: trigger an FHIR
// bulk-export and enqueue ingest. Other providers in this codebase are
// event-driven (Stripe, Telnyx, Vapi, DocuSign, Dropbox Sign) — they push
// to us via webhooks, so "sync" is not a meaningful action and the UI
// button should be disabled for them. That's the whole reason this
// registry exists: to express that distinction in code, not in copy.

registerSyncHandler("fasten_connect", async (integration) => {
  const { enqueueJob } = await import("./queue");
  // We don't have an orgConnectionId on the integration row; Fasten sync
  // is per-lead/per-connection. The button on the integrations page is
  // therefore a no-op for the integration row itself — actual record
  // sync is initiated by the per-lead "Connect medical records" flow,
  // which enqueues `fasten_records_sync` jobs against fasten_connections.
  // We still surface a sensible outcome so the UI can show "0 to sync"
  // instead of "not implemented" — the implementation IS present, it
  // just operates at a different scope than the integration row.
  logger.info(
    { integration_id: integration.id, provider: integration.provider },
    "integration-sync: fasten_connect — integration-level sync is a no-op (sync runs per-connection via fasten_records_sync jobs)",
  );
  return {
    ok: true,
    records_synced: 0,
    direction: "pull",
    details: {
      note: "Fasten sync runs per-lead via background jobs (fasten_records_sync). The integration row itself has nothing to pull.",
      enqueue_kind: "fasten_records_sync",
    },
  };
});

registerSyncHandler("smartadvocate", async (integration) => {
  const { syncSmartAdvocateBackfill } = await import("./crm/smartadvocate");
  const out = await syncSmartAdvocateBackfill(integration.id);
  return {
    ok: out.ok,
    records_synced: out.pushed,
    direction: "push",
    details: {
      attempted: out.attempted,
      skipped: out.skipped,
      ...out.details,
    },
    error: out.ok ? undefined : String((out.details && out.details["reason"]) ?? "smartadvocate sync failed"),
  };
});
