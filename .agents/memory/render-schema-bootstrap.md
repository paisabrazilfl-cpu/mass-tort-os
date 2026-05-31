---
name: Render schema bootstrap
description: How the Render deploy creates/migrates the Postgres schema, and why drizzle-kit push can't do it there.
---

# Render schema bootstrap

The Render web service brings up its DB schema at **runtime via a committed
script** (`lib/db/apply-schema.mjs`), not via `drizzle-kit push`.

**Why push doesn't work on Render:** `drizzle-kit push` drops its connection
after introspection, *before* applying, and exits 0 silently — so it appears to
succeed but changes nothing. Separately, the Render **build** container has no
network route to the private DB, so any schema work must happen in the **start**
command, not the build.

**The two-phase deploy (in `.render/render.yaml`):**
- BUILD: `pnpm --filter @workspace/db run generate` — offline `drizzle-kit
  generate` emits full DDL to `lib/db/drizzle/*.sql` (no DB connection needed).
  `drizzle.config.ts` skips its DATABASE_URL guard when the command is
  `generate`.
- START: `node lib/db/apply-schema.mjs && node ... index.mjs` — the script takes
  a pg advisory lock, checks sentinel `to_regclass('public.firms')`. Present →
  no-op (never touches a populated DB). Absent → `DROP/CREATE public` + apply all
  statements (split on `--> statement-breakpoint`) in ONE transaction.

**Why:** this logic previously lived ONLY as a base64 blob inside the Render
start command, not in the repo. Recreating the service from the blueprint lost
it and fresh deploys came up with an empty DB (login 500s). Keeping it committed
makes the deploy reproducible.

**How to apply / gotchas:**
- The generated `lib/db/drizzle/` is a gitignored build artifact — regenerated
  each deploy, never committed (project is push-based, no tracked migrations).
- Bootstrap is **destructive only when `public.firms` is missing**. Don't drop
  that table as a recovery step or the next deploy will wipe/recreate the schema.
- The **worker** service does NOT run apply-schema; on a truly fresh DB it can
  crash-loop until the web service finishes bootstrapping, then recovers.
