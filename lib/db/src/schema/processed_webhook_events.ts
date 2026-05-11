import { pgTable, serial, text, timestamp, integer, index, uniqueIndex } from "drizzle-orm/pg-core";

/**
 * Idempotency ledger for inbound provider webhooks (Stripe, Telnyx, Vapi,
 * Fasten, DocuSign, …). Providers retry on any 5xx (and Stripe also retries
 * on long-poll timeouts), so without dedup a single physical delivery
 * report can produce N rows in `sms_messages` / `fax_events` / etc., and
 * downstream automations would fire N times.
 *
 * Contract: callers compute a stable `(provider, external_event_id)` key
 * BEFORE mutating any state. The unique index guarantees only one writer
 * wins; the loser's insert throws a unique-violation that the dedup wrapper
 * catches and treats as a no-op. `external_event_id` is whatever the
 * provider stamps on the body — Stripe `event.id`, Telnyx `payload.id`,
 * Vapi `call.id`, Fasten `event.id`, etc.
 *
 * Retention is the operator's call. We don't auto-prune here; a nightly
 * `DELETE WHERE first_seen_at < now() - interval '30 days'` is fine when
 * the provider's retry window (≤ 3 days at most) has long expired.
 */
export const processedWebhookEventsTable = pgTable("processed_webhook_events", {
  id: serial("id").primaryKey(),
  provider: text("provider").notNull(),
  external_event_id: text("external_event_id").notNull(),
  // Optional: which integration row + firm this event belongs to. Useful
  // for cross-firm audits and for cleaning up after a firm is deleted.
  integration_id: integer("integration_id"),
  firm_id: integer("firm_id"),
  // Free-form snapshot of the event type / status so an operator can scan
  // the ledger without joining back to the source tables.
  event_type: text("event_type"),
  first_seen_at: timestamp("first_seen_at").defaultNow().notNull(),
}, (t) => ({
  // The dedup primary key. Composite unique so the same external id is
  // OK across providers (e.g. a number collision between Telnyx and Vapi).
  providerEventUx: uniqueIndex("processed_webhook_events_provider_event_ux").on(t.provider, t.external_event_id),
  firmIdx: index("processed_webhook_events_firm_idx").on(t.firm_id),
  seenAtIdx: index("processed_webhook_events_first_seen_idx").on(t.first_seen_at),
}));
