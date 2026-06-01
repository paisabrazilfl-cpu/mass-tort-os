---
name: Schema table removal lifecycle
description: How to fully drop a Drizzle table from this repo (schema + dev + prod bootstrap), and why drift won't catch DB-only orphans.
---

# Dropping a table from the schema

Removing a table cleanly takes FOUR coordinated steps, not just deleting the schema file:

1. Delete `lib/db/src/schema/<table>.ts` (and any child table that FK-references it).
2. Remove its `export * from "./<table>"` line in `lib/db/src/schema/index.ts`.
3. Drop it in the **dev DB** directly (`DROP TABLE IF EXISTS ... CASCADE`, dependents first) — the workspace `DATABASE_URL` is the dev DB.
4. Add it to `ORPHANED_TABLES` in `lib/db/apply-schema.mjs` so already-provisioned DBs (Render prod) sweep it on next boot. The fresh-DB path doesn't need it (DROP SCHEMA wipes everything), but the sentinel short-circuits the full bootstrap on existing DBs, so prod keeps the orphan forever without an explicit idempotent drop in the sentinel-present branch.

**Why drift didn't flag the orphan:** `lib/db/scripts/check-drift.ts` only walks tables the Drizzle schema *knows about* — it intentionally does NOT report tables present in the live DB but absent from the schema. So a removed-from-schema-but-still-in-DB table is invisible to `db-drift` (stays green). That's the exact gap that lets orphaned tables linger.

`lib/db/drizzle/` (generated DDL + meta snapshot) is **gitignored** — Render regenerates it at build via `drizzle-kit generate`, then `apply-schema.mjs` applies it at start. So the only committed source of truth is the schema `.ts` files; regenerating locally is just validation.
