#!/usr/bin/env bash
# CI gate: confirm the per-route protection matrix in
# docs/audits/rbac-remediation-2026-04-26.md (Section 11) is in sync with
# the live express route tree.
#
# Walks the actual mounted router via dump-route-matrix.ts and diffs the
# generated table against the table embedded in the audit doc. A non-empty
# diff means the matrix is stale (a route was added, removed, or its
# protection metadata changed) — regenerate Section 11 and commit it.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
AUDIT_DOC="${ROOT}/docs/audits/rbac-remediation-2026-04-26.md"
DUMP_SCRIPT="src/scripts/dump-route-matrix.ts"

if [[ ! -f "${AUDIT_DOC}" ]]; then
  echo "ERROR: audit doc not found at ${AUDIT_DOC}" >&2
  exit 2
fi

GENERATED="$(mktemp)"
EMBEDDED="$(mktemp)"
trap 'rm -f "${GENERATED}" "${EMBEDDED}"' EXIT

# Generate the live matrix. dump-route-matrix.ts prints the markdown table
# on stdout and a `Total rows: N` line on stderr; capture stdout only.
(
  cd "${ROOT}"
  pnpm --filter @workspace/api-server exec tsx "${DUMP_SCRIPT}" \
    > "${GENERATED}" 2>/dev/null
)

# Extract the embedded table from the audit doc: from the "| Router | Method
# | Path |" header through the rest of the file. The audit doc is written
# so Section 11's table is the final block, with no trailing prose.
awk '/^\| Router \| Method \| Path \|/{found=1} found' \
  "${AUDIT_DOC}" > "${EMBEDDED}"

if ! diff -u "${EMBEDDED}" "${GENERATED}" > /tmp/rbac-matrix.diff; then
  echo "ERROR: route protection matrix is out of sync." >&2
  echo "" >&2
  echo "The matrix embedded in Section 11 of" >&2
  echo "  ${AUDIT_DOC}" >&2
  echo "no longer matches the live route tree. Regenerate it with:" >&2
  echo "" >&2
  echo "  pnpm --filter @workspace/api-server exec tsx \\" >&2
  echo "    artifacts/api-server/${DUMP_SCRIPT} > /tmp/routes-table.md" >&2
  echo "" >&2
  echo "then replace the table at the end of the audit doc with the new" >&2
  echo "contents of /tmp/routes-table.md and commit." >&2
  echo "" >&2
  echo "--- diff (embedded vs live) ---" >&2
  cat /tmp/rbac-matrix.diff >&2
  exit 1
fi

ROW_COUNT="$(grep -c '^| ' "${GENERATED}" || true)"
echo "OK: route protection matrix in sync (${ROW_COUNT} rows including header)."
