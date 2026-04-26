/**
 * Run the cases ownership backfill (Task #22).
 *
 * Order of operations:
 *   1. Backfill every `cases` row where `created_by_user_id IS NULL`
 *      using audit-log inference + system-user fallback.
 *   2. Add the indexes that back the viewer ownership filter.
 *   3. Promote `created_by_user_id` to NOT NULL.
 *
 * Steps 2 and 3 are run AFTER the backfill so the NOT NULL alter cannot
 * trip on a leftover orphan row. All three are idempotent — re-runs are
 * safe.
 *
 * Run via:
 *   pnpm --filter @workspace/api-server exec tsx \
 *     src/scripts/backfill-case-ownership.ts
 */
import { pool } from "@workspace/db";
import { logger } from "../lib/logger";
import {
  backfillCaseOwnership,
  applyOwnershipDdl,
  ownershipTablesExist,
} from "../lib/case-ownership-backfill";

async function main(): Promise<void> {
  // Skip cleanly on a fresh DB where neither the cases nor mtos_users
  // table exists yet. The follow-up `pnpm db push` step in post-merge.sh
  // will create them with NOT NULL already in place — there's nothing to
  // backfill in that case.
  if (!(await ownershipTablesExist())) {
    logger.info({}, "Case ownership backfill: tables not yet present, skipping (fresh DB)");
    return;
  }

  const result = await backfillCaseOwnership();
  logger.info(result, "Case ownership backfill complete");

  await applyOwnershipDdl();
  logger.info({}, "Cases ownership DDL applied (indexes + NOT NULL constraint)");
}

main()
  .then(async () => {
    await pool.end();
    process.exit(0);
  })
  .catch(async (err) => {
    logger.error({ err }, "Case ownership backfill failed");
    await pool.end().catch(() => {});
    process.exit(1);
  });
