---
name: Render deploy — creating the DB schema on a fresh DB
description: How to provision the Postgres schema when deploying this monorepo to Render with an empty database.
---

Deploying to Render with a FRESH empty Postgres needs the schema created. The
obvious tools all fail here; the working recipe is below.

**What does NOT work:**
- `drizzle-kit push` (any variant) — it pulls/introspects the schema, then drops
  the connection BEFORE the apply step and **exits 0 (swallows the error)**.
  Reproduced over BOTH the external link AND Render's internal connection, so it
  is a drizzle-kit bug, not the network. Build "succeeds" with zero tables.
- Applying schema from the Replit workspace over the EXTERNAL Render PG URL —
  `psql`/node-pg both die with "SSL connection has been closed unexpectedly"
  (Render appears to throttle/close external connections, worse on small plans).
- Running migrations in the Render BUILD step — the build environment has **no
  network route to the DB's private network**, so any DB connection at build
  time fails (and drizzle-kit swallows it). Migrations must run at RUNTIME.

**What WORKS (runtime apply over the stable internal connection):**
1. At BUILD: `drizzle-kit generate` (offline, no DB) emits the full DDL into
   `lib/db/drizzle/*.sql`; this file persists into the runtime filesystem.
2. A tiny node+`pg` script (baked into the build via base64 in the build command,
   since the main agent can't `git commit`) runs in the START command BEFORE the
   server: it connects over the internal `DATABASE_URL`, checks
   `to_regclass('public.firms')` as a sentinel, and if absent does
   `DROP SCHEMA public CASCADE; CREATE SCHEMA public;` then applies all DDL
   statements (split on `--> statement-breakpoint`) in one transaction. Idempotent
   on redeploys (skips when the sentinel table exists).
3. The DROP SCHEMA clean-slate is essential because earlier failed `push`
   attempts leave a PARTIAL set of tables — a plain CREATE then fails with
   "relation X already exists".

**Why drizzle.config throws without DATABASE_URL:** even `generate` (which never
connects) needs the env var set, so set a placeholder for offline generate.

**Gotchas:**
- The long-running WORKER service caches its DB connection; after the schema is
  (re)created it keeps erroring "relation does not exist" until you RESTART it.
- These build/start commands live in Render service config, NOT in the repo's
  `.render/render.yaml`. Persisting them to the repo needs a task-agent commit.
