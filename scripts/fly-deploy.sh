#!/usr/bin/env bash
set -euo pipefail

export PATH="/home/runner/.fly/bin:$PATH"
TOKEN=$(printenv FLY_API_TOKEN)
mkdir -p ~/.fly
printf 'access_token: "%s"\n' "$TOKEN" > ~/.fly/config.yml

echo "=== flyctl whoami ==="
flyctl auth whoami

echo "=== Creating app (may already exist) ==="
flyctl apps create mtos-crm --org personal 2>&1 || true

echo "=== Setting secrets ==="
flyctl secrets set \
  DATABASE_URL="$(printenv DATABASE_URL)" \
  SESSION_SECRET="$(printenv SESSION_SECRET)" \
  ENCRYPTION_KEY_V1="$(printenv ENCRYPTION_KEY_V1)" \
  ENCRYPTION_KEY_V2="$(printenv ENCRYPTION_KEY_V2)" \
  BITDEER_API_KEY="$(printenv BITDEER_API_KEY)" \
  AI_PROVIDER="bitdeer" \
  AI_PROVIDER_LEAD_INTELLIGENCE="bitdeer" \
  NODE_ENV="production" \
  --app mtos-crm 2>&1

echo "=== Deploying ==="
flyctl deploy \
  --app mtos-crm \
  --config fly.toml \
  --dockerfile Dockerfile \
  --remote-only \
  --wait-timeout 300 \
  2>&1

echo "=== Done ==="
flyctl status --app mtos-crm 2>&1
