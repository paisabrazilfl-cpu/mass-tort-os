-- Idempotent backfill: stamp every case row with firm_id so the multi-tenant
-- analytics aggregates and GET /cases scoping introduced in this audit work
-- against historical rows. Safe to re-run.
--
-- The single-firm shell (rbac.ts, firm-bootstrap.ts) seeds firm_id=1 as the
-- default firm slug='default'. Every legacy `cases` row that pre-dates the
-- firm_id column belongs to that firm by construction (the deployment had
-- exactly one firm). We use COALESCE to leave any already-set firm_id alone.
--
-- If you run a multi-firm deployment, REPLACE the literal `1` below with a
-- query that maps each case to its owning firm (e.g. via created_by_user_id
-- → users.firm_id) BEFORE running.

ALTER TABLE cases ADD COLUMN IF NOT EXISTS firm_id integer;
CREATE INDEX IF NOT EXISTS cases_firm_id_idx ON cases(firm_id);

UPDATE cases c
SET    firm_id = COALESCE(
         c.firm_id,
         (SELECT u.firm_id FROM mtos_users u WHERE u.id = c.created_by_user_id),
         1
       )
WHERE  c.firm_id IS NULL;
