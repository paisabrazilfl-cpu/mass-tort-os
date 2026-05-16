-- Backfill legacy automation_workflows / automation_runs rows that have
-- NULL firm_id. The routes in src/routes/automations.ts now require strict
-- firm scope (`WHERE firm_id = $caller.firm_id`), so legacy NULL rows are
-- invisible until they get a firm_id assigned.
--
-- Run this AFTER deploying the strict-scope routes. Pre-strict, those
-- legacy rows were leaking across all firms via the old `fWhere()` helper
-- that returned `1=1` when the request had no firm context — making
-- "invisible to all firms" a strictly safer failure mode than the prior
-- "visible to all firms."
--
-- Strategy:
--   1. For workflows with a known creator (created_by_user_id), inherit
--      the user's firm_id from mtos_users.
--   2. Anything still NULL after step 1 belongs to no real owner — either
--      a seed row or pre-multi-tenant data. Park them on the seed firm
--      (slug='default', id=1) so an operator can review and re-assign.
--   3. Runs follow their parent workflow's firm_id.
--
-- Idempotent: safe to re-run; only touches rows that are still NULL.

BEGIN;

-- 1. Inherit firm_id from the creator's user record.
UPDATE automation_workflows aw
SET firm_id = u.firm_id,
    updated_at = NOW()
FROM mtos_users u
WHERE aw.firm_id IS NULL
  AND aw.created_by_user_id IS NOT NULL
  AND u.id = aw.created_by_user_id
  AND u.firm_id IS NOT NULL;

-- 2. Park any remaining orphan workflows on the seed firm. If the seed
--    firm doesn't exist (fresh install with no firms yet), this is a
--    no-op and the rows stay NULL — which is fine because there are no
--    users yet to see them either.
UPDATE automation_workflows
SET firm_id = (SELECT id FROM firms WHERE slug = 'default' LIMIT 1),
    updated_at = NOW()
WHERE firm_id IS NULL
  AND EXISTS (SELECT 1 FROM firms WHERE slug = 'default');

-- 3. Backfill automation_runs from their parent workflow's firm_id.
UPDATE automation_runs ar
SET firm_id = aw.firm_id
FROM automation_workflows aw
WHERE ar.firm_id IS NULL
  AND ar.workflow_id = aw.id
  AND aw.firm_id IS NOT NULL;

COMMIT;

-- Verify: should return 0 rows after a successful backfill on a healthy DB.
-- SELECT COUNT(*) AS orphan_workflows FROM automation_workflows WHERE firm_id IS NULL;
-- SELECT COUNT(*) AS orphan_runs FROM automation_runs WHERE firm_id IS NULL;
