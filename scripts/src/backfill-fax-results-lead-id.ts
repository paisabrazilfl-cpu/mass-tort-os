/**
 * Task #16 backfill: populate `fax_results.lead_id` for legacy rows whose
 * column is NULL by parsing the canonical `source_file` filename pattern
 * (`med_records_request_lead_<id>_env_<envelope_id>.pdf`).
 *
 * Idempotent — re-runnable. Skips rows that already carry a non-null
 * lead_id, and rows whose source_file does not match the convention.
 *
 * Usage:
 *   pnpm --filter @workspace/scripts run backfill-fax-results-lead-id
 *   pnpm --filter @workspace/scripts run backfill-fax-results-lead-id -- --dry
 */
import { db, faxResultsTable } from "@workspace/db";
import { isNull, eq } from "drizzle-orm";

// Inlined parser (kept in lockstep with
// artifacts/api-server/src/lib/fax-results-matcher.ts::parseFaxSourceFile).
// We don't import across the api-server rootDir because @workspace/scripts is
// a leaf package without a project reference to api-server. Both copies match
// the same SOURCE_FILE_TEMPLATE the worker emits.
function parseFaxSourceFile(sourceFile: string | null | undefined): { lead_id: number } | null {
  if (typeof sourceFile !== "string" || sourceFile.length === 0) return null;
  const match = sourceFile.match(/^med_records_request_lead_(\d+)_env_(.+)\.pdf$/);
  if (!match) return null;
  const leadId = Number(match[1]);
  if (!Number.isInteger(leadId) || leadId <= 0) return null;
  if (!match[2] || match[2].length === 0) return null;
  return { lead_id: leadId };
}

async function main(): Promise<void> {
  const dry = process.argv.includes("--dry");
  const candidates = await db
    .select({ id: faxResultsTable.id, source_file: faxResultsTable.source_file })
    .from(faxResultsTable)
    .where(isNull(faxResultsTable.lead_id));

  let matched = 0;
  let updated = 0;
  let skipped = 0;
  for (const row of candidates) {
    const parsed = parseFaxSourceFile(row.source_file);
    if (!parsed) {
      skipped++;
      continue;
    }
    matched++;
    if (dry) continue;
    await db
      .update(faxResultsTable)
      .set({ lead_id: parsed.lead_id })
      .where(eq(faxResultsTable.id, row.id));
    updated++;
  }

  // eslint-disable-next-line no-console
  console.log(
    JSON.stringify(
      {
        scanned: candidates.length,
        matched,
        updated,
        skipped_unparseable: skipped,
        dry_run: dry,
      },
      null,
      2,
    ),
  );
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    // eslint-disable-next-line no-console
    console.error("backfill-fax-results-lead-id failed:", err);
    process.exit(1);
  });
