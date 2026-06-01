// Schema-vs-Database drift detector for the push-based workflow.
//
// Why this exists: drizzle-kit check (in v0.31.x) only validates
// migration journal coherence — it does NOT compare lib/db/src/schema/*.ts
// against the live PostgreSQL database. drizzle-kit push reconciles them
// but mutates the DB silently for additive changes. This script is the
// missing read-only gate: it inspects every Drizzle table object exported
// from @workspace/db, queries information_schema for the matching live
// table, and reports any name- or nullability-level disagreement.
//
// Exits 0 when in sync, 1 when column-level drift is found. Never mutates the DB.
//
// Orphaned-table warning (v2): in addition to walking Drizzle-known tables, the
// script now lists every BASE TABLE in the live schema and reports any that the
// Drizzle schema no longer defines — a "table present in DB, missing in schema"
// warning. This catches leftover tables from removed features (e.g. the Sites AI
// `conversations`/`messages` tables) that would otherwise linger in the live DB
// forever while the check stayed green. The warning is INFORMATIONAL and printed
// in a clearly separated block: it does NOT change the exit code, so a legitimate
// untracked table (extension-owned, etc.) can't break CI on its own. Genuine
// orphans are still surfaced loudly so someone notices and runs the
// `ORPHANED_TABLES` sweep in lib/db/apply-schema.mjs to drop them.
//
// Allowlist: tables that are intentionally present in the DB but never modeled in
// Drizzle (extension-owned tables such as PostGIS `spatial_ref_sys`, or any
// other deliberately-untracked table) belong in ORPHAN_ALLOWLIST below so they
// are excluded from the warning. The list starts empty — this database has no
// such tables today — but add an entry (with a reason) when one legitimately
// appears.
//
// Limitations (intentional):
// - Compares column NAMES and NULLABILITY only. Type drift (e.g. varchar(50)
//   shrunk to varchar(20)) is not flagged — that's rare in practice and
//   cheap to add later via getSQLType()/data_type normalization.
// - Treats column renames as drop+add (drizzle-kit can't disambiguate
//   either without explicit guidance).
// - Orphaned-table detection scans the current schema only (current_schema()),
//   matching the column comparison above. Tables in other schemas are ignored.

import { getTableColumns, getTableName, is, Table } from "drizzle-orm";
import { pool } from "@workspace/db";
import * as schema from "@workspace/db";

// Tables that legitimately exist in the live DB but are intentionally never
// modeled in Drizzle. Anything listed here is excluded from the orphaned-table
// warning. Add an entry only with a clear reason (e.g. extension-owned tables).
// Empty today — this database has no deliberately-untracked tables.
const ORPHAN_ALLOWLIST = new Set<string>([
  // "spatial_ref_sys", // example: created by the PostGIS extension
]);

interface ColumnInfo {
  column_name: string;
  is_nullable: "YES" | "NO";
}

function isColumnInfo(value: unknown): value is ColumnInfo {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.column_name === "string" &&
    (v.is_nullable === "YES" || v.is_nullable === "NO")
  );
}

interface DriftItem {
  table: string;
  kind: "missing_in_db" | "missing_in_schema" | "nullable_mismatch";
  column: string;
  detail?: string;
}

async function fetchLiveColumns(tableName: string): Promise<ColumnInfo[]> {
  // Use pg's pool.query directly (not drizzle's db.execute) so the result
  // shape is the well-typed pg.QueryResult<T>. The validateRow guard then
  // confirms each row matches ColumnInfo at runtime, so a future Drizzle/pg
  // change can't silently invalidate the comparison logic — it would throw.
  const result = await pool.query<ColumnInfo>(
    `SELECT column_name, is_nullable
     FROM information_schema.columns
     WHERE table_schema = current_schema()
       AND table_name = $1
     ORDER BY ordinal_position`,
    [tableName],
  );
  for (const row of result.rows) {
    if (!isColumnInfo(row)) {
      throw new Error(
        `check-drift: information_schema.columns row for table "${tableName}" did not match expected shape: ${JSON.stringify(row)}`,
      );
    }
  }
  return result.rows;
}

async function fetchLiveTableNames(): Promise<string[]> {
  const result = await pool.query<{ table_name: string }>(
    `SELECT table_name
     FROM information_schema.tables
     WHERE table_schema = current_schema()
       AND table_type = 'BASE TABLE'
     ORDER BY table_name`,
  );
  for (const row of result.rows) {
    if (!row || typeof row.table_name !== "string") {
      throw new Error(
        `check-drift: information_schema.tables row did not match expected shape: ${JSON.stringify(row)}`,
      );
    }
  }
  return result.rows.map((r) => r.table_name);
}

function collectTables(): Table[] {
  const tables: Table[] = [];
  for (const value of Object.values(schema as Record<string, unknown>)) {
    if (value && typeof value === "object" && is(value as object, Table)) {
      tables.push(value as Table);
    }
  }
  return tables;
}

async function main(): Promise<void> {
  const tables = collectTables();
  if (tables.length === 0) {
    console.error("check-drift: no tables found in @workspace/db schema");
    process.exit(2);
  }

  // Orphaned-table detection: live BASE TABLEs that the Drizzle schema no longer
  // defines (and aren't deliberately allowlisted). Informational only.
  const knownTableNames = new Set(tables.map((t) => getTableName(t)));
  const liveTableNames = await fetchLiveTableNames();
  const orphanedTables = liveTableNames.filter(
    (name) => !knownTableNames.has(name) && !ORPHAN_ALLOWLIST.has(name),
  );

  const drift: DriftItem[] = [];
  let tablesScanned = 0;

  for (const table of tables) {
    const tableName = getTableName(table);
    tablesScanned++;
    const expected = getTableColumns(table);
    const live = await fetchLiveColumns(tableName);

    if (live.length === 0) {
      // Table missing entirely — flag every expected column as missing.
      for (const colName of Object.keys(expected)) {
        drift.push({
          table: tableName,
          kind: "missing_in_db",
          column: expected[colName]!.name,
          detail: "table itself missing from live database",
        });
      }
      continue;
    }

    const liveByName = new Map<string, ColumnInfo>();
    for (const c of live) liveByName.set(c.column_name, c);

    const expectedByName = new Map<string, { notNull: boolean }>();
    for (const colName of Object.keys(expected)) {
      const col = expected[colName]!;
      expectedByName.set(col.name, { notNull: col.notNull });
    }

    // Schema → DB direction: columns expected but missing or with wrong nullability.
    for (const [name, exp] of expectedByName) {
      const liveCol = liveByName.get(name);
      if (!liveCol) {
        drift.push({ table: tableName, kind: "missing_in_db", column: name });
        continue;
      }
      const liveNotNull = liveCol.is_nullable === "NO";
      if (liveNotNull !== exp.notNull) {
        drift.push({
          table: tableName,
          kind: "nullable_mismatch",
          column: name,
          detail: `schema notNull=${exp.notNull}, live notNull=${liveNotNull}`,
        });
      }
    }

    // DB → schema direction: columns present in DB but not in schema.
    for (const [name] of liveByName) {
      if (!expectedByName.has(name)) {
        drift.push({ table: tableName, kind: "missing_in_schema", column: name });
      }
    }
  }

  if (drift.length === 0) {
    console.log(
      `check-drift: OK — ${tablesScanned} tables in sync with database.`,
    );
    reportOrphanedTables(orphanedTables);
    await pool.end();
    process.exit(0);
  }

  console.error(
    `check-drift: FAIL — ${drift.length} drift item(s) across ${tablesScanned} tables.\n`,
  );
  // Group by table for readability.
  const byTable = new Map<string, DriftItem[]>();
  for (const d of drift) {
    const list = byTable.get(d.table) ?? [];
    list.push(d);
    byTable.set(d.table, list);
  }
  for (const [tbl, items] of byTable) {
    console.error(`  ${tbl}:`);
    for (const i of items) {
      const tag =
        i.kind === "missing_in_db"
          ? "MISSING IN DB"
          : i.kind === "missing_in_schema"
            ? "MISSING IN SCHEMA"
            : "NULLABILITY";
      console.error(
        `    [${tag}] ${i.column}${i.detail ? ` — ${i.detail}` : ""}`,
      );
    }
  }
  console.error(
    "\nFix by editing lib/db/src/schema/*.ts and running `pnpm --filter @workspace/db run push`,",
  );
  console.error(
    "then re-run `pnpm --filter @workspace/db run drift` to confirm.",
  );
  reportOrphanedTables(orphanedTables);
  await pool.end();
  process.exit(1);
}

/**
 * Print a clearly-separated, loud warning listing tables that exist in the live
 * database but are no longer defined in the Drizzle schema. Informational only —
 * the caller does not change its exit code based on this. A no-op when there are
 * no orphaned tables.
 */
function reportOrphanedTables(orphanedTables: string[]): void {
  if (orphanedTables.length === 0) return;
  console.warn(
    `\n========================================================================`,
  );
  console.warn(
    `check-drift: WARNING — ${orphanedTables.length} table(s) present in DB but missing from schema:`,
  );
  for (const name of orphanedTables) {
    console.warn(`    [ORPHANED TABLE] ${name}`);
  }
  console.warn(
    "\nThese tables exist in the live database but no Drizzle schema defines them —",
  );
  console.warn(
    "likely leftovers from a removed feature. This is informational and does NOT",
  );
  console.warn("fail the check. To resolve each orphan, either:");
  console.warn(
    "  • drop it: add it to ORPHANED_TABLES in lib/db/apply-schema.mjs so",
  );
  console.warn(
    "    already-provisioned databases sweep it on next boot, then drop it in dev; or",
  );
  console.warn(
    "  • keep it intentionally: add it to ORPHAN_ALLOWLIST in this script (with a reason).",
  );
  console.warn(
    `========================================================================`,
  );
}

main().catch(async (err) => {
  console.error("check-drift: crashed:", err);
  try {
    await pool.end();
  } catch {
    /* pool already closed */
  }
  process.exit(2);
});
