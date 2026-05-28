#!/usr/bin/env bash
set -euo pipefail

# Railway deployment script for MTOS CRM
# Uses Railway GraphQL API to redeploy the last successful build
# or trigger a fresh deployment from the connected GitHub repo.

TOKEN="${RAILWAY_TOKEN:-}"
if [[ -z "$TOKEN" ]]; then
  echo "ERROR: RAILWAY_TOKEN is not set" >&2
  exit 1
fi

PROJECT_ID="449d45e8-ef92-4566-abe0-2e433a092292"
SERVICE_ID="725b8dc5-2443-4f14-8997-3323bc297dee"
ENV_ID="54e1428a-d566-496a-b6c7-a7589646abcd"

gql() {
  curl -s -X POST https://backboard.railway.app/graphql/v2 \
    -H "Authorization: Bearer $TOKEN" \
    -H "Content-Type: application/json" \
    -d "$1"
}

echo "=== Finding latest successful deployment ==="
LAST_GOOD=$(gql "{\"query\":\"{ deployments(input: { serviceId: \\\"$SERVICE_ID\\\", environmentId: \\\"$ENV_ID\\\" }) { edges { node { id status } } } }\"}" \
  | python3 -c "
import sys,json
d=json.load(sys.stdin)
for e in d['data']['deployments']['edges']:
  n=e['node']
  if n['status']=='SUCCESS':
    print(n['id'])
    break
")

if [[ -z "$LAST_GOOD" ]]; then
  echo "ERROR: No successful deployment found to redeploy from" >&2
  exit 1
fi

echo "Redeploying from: $LAST_GOOD"
RESULT=$(gql "{\"query\":\"mutation { deploymentRedeploy(id: \\\"$LAST_GOOD\\\") { id status } }\"}")
DEPLOY_ID=$(echo "$RESULT" | python3 -c "import sys,json; print(json.load(sys.stdin)['data']['deploymentRedeploy']['id'])")
echo "New deployment ID: $DEPLOY_ID"

echo "=== Waiting for deployment to complete ==="
for i in $(seq 1 36); do
  STATUS=$(gql "{\"query\":\"{ deployment(id: \\\"$DEPLOY_ID\\\") { id status url } }\"}" \
    | python3 -c "import sys,json; d=json.load(sys.stdin)['data']['deployment']; print(d['status'], d.get('url') or '')" 2>/dev/null)
  echo "$(date '+%H:%M:%S') — $STATUS"
  if echo "$STATUS" | grep -qE "^SUCCESS|^FAILED|^CRASHED"; then
    break
  fi
  sleep 10
done

echo "$STATUS" | grep -q "^SUCCESS" && echo "=== Deploy succeeded ===" || { echo "=== Deploy FAILED ===" >&2; exit 1; }
