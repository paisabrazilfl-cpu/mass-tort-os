// One-shot DB bootstrap: drop everything in the public schema, then apply
// the drizzle migrations from scratch. Used as the api-server's
// preDeployCommand on the FIRST deploy only — after the database is
// populated, switch the preDeployCommand to just `drizzle-kit migrate`
// (which is idempotent via the __drizzle_migrations tracking table).
//
// Why a wipe is needed at all: the api-server's index.ts has a runtime
// schema-repair routine that creates a SUBSET of tables (firms,
// automation_*, api_keys, workflow_settings, etc.) via raw SQL. These
// shadow rows then collide with `drizzle-kit migrate`'s bare
// CREATE TABLE statements. Wiping + re-migrating gives us a known-good
// canonical schema.
//
// Safety: refuses to run unless RESET_DB=1 is set in the environment.
// On Railway you set this for ONE deploy, observe success, then remove
// it before the next deploy so the script becomes a no-op.

import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DATABASE_URL = process.env["DATABASE_URL"];
if (!DATABASE_URL) {
  console.error("DATABASE_URL not set");
  process.exit(1);
}

const wantsReset = process.env["RESET_DB"] === "1";

const { Pool } = pg;
const pool = new Pool({ connectionString: DATABASE_URL });

async function main() {
  if (wantsReset) {
    console.log("RESET_DB=1 — dropping public schema");
    await pool.query("DROP SCHEMA IF EXISTS public CASCADE");
    await pool.query("CREATE SCHEMA public");
    await pool.query("GRANT ALL ON SCHEMA public TO public");
    console.log("public schema recreated");
  } else {
    console.log("RESET_DB not set — skipping wipe, running migrations only");
  }

  // Diagnostic: confirm we're talking to the same DB as the app.
  const who = await pool.query("SELECT current_database() AS db, current_user AS usr, inet_server_addr()::text AS host, current_setting('search_path') AS sp");
  console.log("connected:", JSON.stringify(who.rows[0]));

  // List SQL files we're about to apply.
  const fs = await import("node:fs");
  const migrationsFolder = path.resolve(__dirname, "..", "drizzle");
  const sqlFiles = fs.existsSync(migrationsFolder)
    ? fs.readdirSync(migrationsFolder).filter((f) => f.endsWith(".sql")).sort()
    : [];
  console.log(`migrate: folder=${migrationsFolder} files=${JSON.stringify(sqlFiles)}`);

  const db = drizzle(pool);
  await migrate(db, { migrationsFolder });
  console.log("migrate: drizzle migrator returned");

  // Verify tables exist.
  const tables = await pool.query(
    "SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename",
  );
  console.log(`tables in public: ${tables.rows.length} → ${tables.rows.map((r: any) => r.tablename).join(', ').slice(0, 800)}`);

  await pool.end();
}

main().catch((err) => {
  console.error("bootstrap failed:", err);
  process.exit(1);
});
