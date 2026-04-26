#!/usr/bin/env bash
# CI gate: confirm the per-route protection matrix in
# docs/audits/rbac-remediation-2026-04-26.md (Section 11) is in sync with
# the live express route tree.
#
# Walks the actual mounted router via dump-route-matrix.ts and diffs the
# generated table against the table embedded in the audit doc. A non-empty
# diff means the matrix is stale (a route was added, removed, or its
# protection metadata changed) — regenerate Section 11 and commit it.
#
# Also re-derives the "Boot-time count: **N checked / P public / Q protected
# / R unprotected.**" headline that sits just above the table. The headline
# is hand-edited prose and is NOT covered by the table diff (the awk slice
# starts at the table header). If a contributor adds or removes a route the
# table is regenerated correctly, but unless the headline is updated too the
# audit doc would silently lie about how many routes are mounted. This
# second check fails CI if the headline drifts from the live counts emitted
# by validateRouteTable in dump-route-matrix.ts.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# AUDIT_DOC is overridable so the unit test in
# src/lib/__tests__/rbac-route-matrix-headline.test.ts can point this gate
# at a mutated fixture and assert the failure path.
AUDIT_DOC="${AUDIT_DOC:-${ROOT}/docs/audits/rbac-remediation-2026-04-26.md}"
DUMP_SCRIPT="src/scripts/dump-route-matrix.ts"

if [[ ! -f "${AUDIT_DOC}" ]]; then
  echo "ERROR: audit doc not found at ${AUDIT_DOC}" >&2
  exit 2
fi

GENERATED="$(mktemp)"
GENERATED_ERR="$(mktemp)"
EMBEDDED="$(mktemp)"
trap 'rm -f "${GENERATED}" "${GENERATED_ERR}" "${EMBEDDED}"' EXIT

# Generate the live matrix. dump-route-matrix.ts prints the markdown table
# on stdout and a `Boot-time count: ...` + `Total rows: N` line on stderr;
# capture both. LOG_LEVEL=silent suppresses validateRouteTable's pino
# "Route policy report" info log so stderr only carries our two lines.
(
  cd "${ROOT}"
  LOG_LEVEL=silent pnpm --filter @workspace/api-server exec tsx "${DUMP_SCRIPT}" \
    > "${GENERATED}" 2> "${GENERATED_ERR}"
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
  echo "    ${DUMP_SCRIPT} > /tmp/routes-table.md" >&2
  echo "" >&2
  echo "then replace the table at the end of the audit doc with the new" >&2
  echo "contents of /tmp/routes-table.md and commit." >&2
  echo "" >&2
  echo "--- diff (embedded vs live) ---" >&2
  cat /tmp/rbac-matrix.diff >&2
  exit 1
fi

# Headline-count check: the prose line just above the table is hand-edited
# and is NOT covered by the table diff above. Pull the live "Boot-time
# count: ..." line from the dump script's stderr and require it to appear
# verbatim in the audit doc.
LIVE_COUNT_LINE="$(grep '^Boot-time count: ' "${GENERATED_ERR}" | tail -n 1 || true)"
if [[ -z "${LIVE_COUNT_LINE}" ]]; then
  echo "ERROR: dump-route-matrix.ts did not emit a 'Boot-time count: ...' line on stderr." >&2
  echo "       (Did the validateRouteTable call get removed?)" >&2
  echo "--- captured stderr ---" >&2
  cat "${GENERATED_ERR}" >&2
  exit 2
fi

DOC_COUNT_LINE="$(grep '^Boot-time count: ' "${AUDIT_DOC}" | head -n 1 || true)"
if [[ -z "${DOC_COUNT_LINE}" ]]; then
  echo "ERROR: audit doc has no 'Boot-time count: ...' headline above Section 11." >&2
  echo "       Add this line just above the per-route table:" >&2
  echo "         ${LIVE_COUNT_LINE}" >&2
  exit 1
fi

if [[ "${DOC_COUNT_LINE}" != "${LIVE_COUNT_LINE}" ]]; then
  echo "ERROR: Section 11 headline count is stale." >&2
  echo "" >&2
  echo "The 'Boot-time count: ...' prose in" >&2
  echo "  ${AUDIT_DOC}" >&2
  echo "no longer matches the live counts emitted by validateRouteTable." >&2
  echo "Replace the headline with the live one and commit:" >&2
  echo "" >&2
  echo "  audit doc: ${DOC_COUNT_LINE}" >&2
  echo "  live     : ${LIVE_COUNT_LINE}" >&2
  exit 1
fi

ROW_COUNT="$(grep -c '^| ' "${GENERATED}" || true)"
echo "OK: route protection matrix in sync (${ROW_COUNT} rows including header)."
echo "OK: Section 11 headline count matches live: ${LIVE_COUNT_LINE}"
