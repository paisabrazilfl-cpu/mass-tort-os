/**
 * Run the leads ownership backfill (Task #25).
 *
 * Mirrors backfill-case-ownership.ts but for `leads.created_by_user_id`.
 * Order of operations:
 *   1. Backfill every `leads` row where `created_by_user_id IS NULL`
 *      using audit-log inference + system-user fallback.
 *   2. Idempotently assert the ownership index that backs the viewer
 *      scope filter (no NOT NULL promotion — leads ingest paths can
 *      legitimately lack a user context, e.g. vendor webhooks).
 *
 * Both steps are idempotent — re-runs are safe.
 *
 * Run via:
 *   pnpm --filter @workspace/api-server exec tsx \
 *     src/scripts/backfill-lead-ownership.ts
 */
import { pool } from "@workspace/db";
import { logger } from "../lib/logger";
import {
  backfillLeadOwnership,
  applyLeadOwnershipDdl,
  leadOwnershipTablesExist,
} from "../lib/lead-ownership-backfill";

async function main(): Promise<void> {
  if (!(await leadOwnershipTablesExist())) {
    logger.info({}, "Lead ownership backfill: tables not yet present, skipping (fresh DB)");
    return;
  }

  const result = await backfillLeadOwnership();
  logger.info(result, "Lead ownership backfill complete");

  await applyLeadOwnershipDdl();
  logger.info({}, "Lead ownership DDL applied (created_by_user_id index)");
}

main()
  .then(async () => {
    await pool.end();
    process.exit(0);
  })
  .catch(async (err) => {
    logger.error({ err }, "Lead ownership backfill failed");
    await pool.end().catch(() => {});
    process.exit(1);
  });
