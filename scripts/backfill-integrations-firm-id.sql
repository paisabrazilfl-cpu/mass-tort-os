-- Idempotent backfill: stamp every integration row with firm_id so the
-- multi-tenant CRUD scoping and provider-lookup helpers added in this
-- audit work against historical rows. Safe to re-run.
--
-- Default firm (id=1) is the single-firm shell seed (firm-bootstrap.ts).
-- Multi-firm deployments MUST replace the literal `1` below with a mapping
-- query before running.

ALTER TABLE integrations ADD COLUMN IF NOT EXISTS firm_id integer;
CREATE INDEX IF NOT EXISTS integrations_firm_id_idx ON integrations(firm_id);
CREATE INDEX IF NOT EXISTS integrations_firm_provider_idx ON integrations(firm_id, provider);

UPDATE integrations
SET    firm_id = 1
WHERE  firm_id IS NULL;
