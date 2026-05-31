// Runtime schema bootstrap for the Render web service.
//
// Why this exists
// ---------------
// This project uses drizzle-kit's *push* workflow and does not commit
// migration files. On Render that workflow cannot run: `drizzle-kit push`
// drops its connection after introspection (exiting 0 silently), and the
// build container has no network route to the private DB, so schema work
// must happen at RUNTIME (the start command), not at build.
//
// The deploy therefore splits into two phases:
//   1. BUILD: `drizzle-kit generate` emits the full DDL (offline, no DB
//      connection) into lib/db/drizzle/*.sql.
//   2. START: this script runs before the server boots. On a *fresh* DB it
//      drops and recreates the public schema, then applies the generated DDL
//      in a single transaction. On an already-provisioned DB it is a no-op.
//
// This logic used to live ONLY in the Render service's start command (a
// base64-injected blob), so recreating the service from .render/render.yaml
// would lose it and a fresh deploy would come up with an empty database
// (login 500s). Committing it here makes the deployment reproducible.
//
// Idempotency / safety
// --------------------
// - A sentinel check (`to_regclass('public.firms')`) means an existing,
//   populated database is left completely untouched — we never DROP when the
//   schema is already present.
// - A Postgres advisory lock serializes concurrent boots so two instances
//   starting at once can't both try to (re)create the schema.
// - All DDL is applied inside one transaction: either the whole schema lands
//   or nothing does.

import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const { Client } = pg;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DRIZZLE_DIR = path.join(__dirname, "drizzle");

// Sentinel table: if this exists we assume the schema is already applied.
const SENTINEL_TABLE = "public.firms";

// Arbitrary, stable key for the advisory lock that serializes bootstrap.
const ADVISORY_LOCK_KEY = 826134975;

function log(msg, extra) {
  const line = `[apply-schema] ${msg}`;
  if (extra !== undefined) {
    console.log(line, extra);
  } else {
    console.log(line);
  }
}

/**
 * Read every generated *.sql file in lexical order and return the list of
 * individual statements (split on drizzle's `--> statement-breakpoint`
 * marker, with comment-only / empty fragments removed).
 */
function loadStatements() {
  let files;
  try {
    files = readdirSync(DRIZZLE_DIR)
      .filter((f) => f.endsWith(".sql"))
      .sort();
  } catch {
    files = [];
  }

  if (files.length === 0) {
    throw new Error(
      `No .sql files found in ${DRIZZLE_DIR}. The build step must run ` +
        `\`drizzle-kit generate\` before this script.`,
    );
  }

  const statements = [];
  for (const file of files) {
    const raw = readFileSync(path.join(DRIZZLE_DIR, file), "utf8");
    for (const chunk of raw.split("--> statement-breakpoint")) {
      const stripped = chunk
        .split("\n")
        .filter((l) => !l.trim().startsWith("--"))
        .join("\n")
        .trim();
      if (stripped.length > 0) {
        statements.push(stripped);
      }
    }
  }
  return { files, statements };
}

async function main() {
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL must be set to apply the schema.");
  }

  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();

  try {
    // Serialize against any other instance booting at the same time.
    await client.query("SELECT pg_advisory_lock($1)", [ADVISORY_LOCK_KEY]);

    const { rows } = await client.query(
      "SELECT to_regclass($1) AS reg",
      [SENTINEL_TABLE],
    );
    const schemaPresent = rows[0]?.reg != null;

    if (schemaPresent) {
      log(`sentinel ${SENTINEL_TABLE} exists — schema already applied, skipping.`);
      return;
    }

    const { files, statements } = loadStatements();
    log(
      `sentinel ${SENTINEL_TABLE} absent — bootstrapping fresh schema ` +
        `(${statements.length} statements from ${files.length} file(s)).`,
    );

    await client.query("BEGIN");
    try {
      // Fresh start: guarantee a clean public schema. Safe because we only
      // reach here when the sentinel table is absent.
      await client.query("DROP SCHEMA IF EXISTS public CASCADE");
      await client.query("CREATE SCHEMA public");
      await client.query("GRANT ALL ON SCHEMA public TO public");

      for (const stmt of statements) {
        await client.query(stmt);
      }

      await client.query("COMMIT");
      log("schema applied successfully.");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    }
  } finally {
    try {
      await client.query("SELECT pg_advisory_unlock($1)", [ADVISORY_LOCK_KEY]);
    } catch {
      // best-effort; the session ending releases it anyway.
    }
    await client.end();
  }
}

main().catch((err) => {
  console.error("[apply-schema] FAILED:", err);
  process.exit(1);
});
