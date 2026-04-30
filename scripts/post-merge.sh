#!/bin/bash
set -e
pnpm install --frozen-lockfile

# Task #22: backfill case ownership BEFORE drizzle would otherwise try to
# enforce NOT NULL on cases.created_by_user_id. The script is idempotent
# and itself applies the indexes + NOT NULL constraint, so the subsequent
# db push is a no-op for that column and just picks up any other schema
# diffs.
pnpm --filter @workspace/api-server exec tsx src/scripts/backfill-case-ownership.ts

# Task #25: same idempotent pattern for leads.created_by_user_id. Runs
# AFTER cases backfill so they share the SYSTEM_USER row (single ensure
# call wins, second one is a no-op via ON CONFLICT DO NOTHING).
pnpm --filter @workspace/api-server exec tsx src/scripts/backfill-lead-ownership.ts

pnpm --filter db push
