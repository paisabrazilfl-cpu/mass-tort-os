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

**Drift now warns on orphans (v2):** `lib/db/scripts/check-drift.ts` additionally lists every live BASE TABLE in `current_schema()` and prints a loud, clearly-separated WARNING for any not defined in Drizzle (and not in its `ORPHAN_ALLOWLIST`). It's **informational only — does NOT change the exit code**, so a legitimate untracked table (e.g. extension-owned) can't redden CI. So removed-from-schema-but-still-in-DB tables now surface in `db-drift` output (still exit 0); you still have to act (ORPHANED_TABLES sweep or allowlist). Pre-existing dev orphans like `conversations`/`messages` will show up here until dropped from the dev DB.

`lib/db/drizzle/` (generated DDL + meta snapshot) is **gitignored** — Render regenerates it at build via `drizzle-kit generate`, then `apply-schema.mjs` applies it at start. So the only committed source of truth is the schema `.ts` files; regenerating locally is just validation.
