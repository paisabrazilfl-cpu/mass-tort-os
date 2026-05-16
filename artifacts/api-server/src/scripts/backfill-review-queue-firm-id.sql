-- Backfill legacy review_queue rows with firm_id derived from their
-- parent entity (lead / case). Pre-migration the table had no firm_id
-- column, so every authenticated user with REVIEW_QUEUE_VIEW saw every
-- firm's review items. The new strict-scope route refuses to return
-- NULL-firm rows, so this script must run after the column-add migration
-- and before the strict-scope route takes traffic.
--
-- Strategy:
--   1. entity_type='lead'  → leads.firm_id WHERE leads.id::text = entity_id
--   2. entity_type='case'  → cases.firm_id WHERE cases.id      = entity_id
--   3. Anything else stays NULL (and is therefore invisible) until an
--      operator hand-classifies it. Safer than guessing.
--
-- Idempotent: re-runs only touch rows that are still NULL.

BEGIN;

-- 1. lead-scoped review items
UPDATE review_queue rq
SET firm_id = l.firm_id
FROM leads l
WHERE rq.firm_id IS NULL
  AND rq.entity_type = 'lead'
  AND l.id::text = rq.entity_id
  AND l.firm_id IS NOT NULL;

-- 2. case-scoped review items (cases.id is varchar, no cast needed)
UPDATE review_queue rq
SET firm_id = c.firm_id
FROM cases c
WHERE rq.firm_id IS NULL
  AND rq.entity_type = 'case'
  AND c.id = rq.entity_id
  AND c.firm_id IS NOT NULL;

COMMIT;

-- Verify: should return the count of remaining un-classifiable items.
-- SELECT entity_type, COUNT(*) FROM review_queue WHERE firm_id IS NULL GROUP BY entity_type;
