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
// Exits 0 when in sync, 1 when drift is found. Never mutates the DB.
//
// Limitations (intentional, v1):
// - Compares column NAMES and NULLABILITY only. Type drift (e.g. varchar(50)
//   shrunk to varchar(20)) is not flagged — that's rare in practice and
//   cheap to add later via getSQLType()/data_type normalization.
// - Treats column renames as drop+add (drizzle-kit can't disambiguate
//   either without explicit guidance).
// - Does not flag tables in the DB that aren't in the schema (e.g. tables
//   from extensions). Only walks tables the Drizzle schema knows about.

import { getTableColumns, getTableName, is, Table } from "drizzle-orm";
import { pool } from "@workspace/db";
import * as schema from "@workspace/db";

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
  await pool.end();
  process.exit(1);
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
