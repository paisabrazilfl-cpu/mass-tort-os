-- Create the inbound-webhook idempotency ledger. Drizzle's `push` will pick
-- this up from `lib/db/src/schema/processed_webhook_events.ts`, but we ship
-- the explicit DDL so an operator can apply it without running the migrate
-- pipeline (e.g. when a hotfix needs to land before the next push window).
-- Safe to re-run.

CREATE TABLE IF NOT EXISTS processed_webhook_events (
  id                  serial PRIMARY KEY,
  provider            text NOT NULL,
  external_event_id   text NOT NULL,
  integration_id      integer,
  firm_id             integer,
  event_type          text,
  first_seen_at       timestamp NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS processed_webhook_events_provider_event_ux
  ON processed_webhook_events (provider, external_event_id);
CREATE INDEX IF NOT EXISTS processed_webhook_events_firm_idx
  ON processed_webhook_events (firm_id);
CREATE INDEX IF NOT EXISTS processed_webhook_events_first_seen_idx
  ON processed_webhook_events (first_seen_at);
