---
name: Route-matrix audit-doc lockstep
description: Adding/removing any api-server route fails the rbac-route-matrix gate until the audit doc table AND headline count are regenerated.
---

Adding (or removing) ANY mounted api-server route — even a perm-gated sub-route under an existing router — fails the `rbac-route-matrix` workflow (`scripts/check-rbac-route-matrix.sh`) until you regenerate the embedded matrix in `docs/audits/rbac-remediation-2026-04-26.md`.

**Why:** the gate diffs the live route tree (via `src/scripts/dump-route-matrix.ts`) against the markdown table embedded at the END of that audit doc (Section 11), and separately checks the hand-edited `Boot-time count: **N checked / P public / Q protected / R unprotected.**` headline that sits just ABOVE the table. The table diff does NOT cover the headline.

**How to apply:** after any route change, run:
```
LOG_LEVEL=silent pnpm --filter @workspace/api-server exec tsx src/scripts/dump-route-matrix.ts > /tmp/routes-table.md 2>/tmp/headline.txt
```
Then (1) replace everything in the audit doc from the `| Router | Method | Path |` header to EOF with `/tmp/routes-table.md`, and (2) copy the `Boot-time count: ...` line from stderr into the doc's headline. Re-run `bash scripts/check-rbac-route-matrix.sh` until it prints OK twice.

This is a DIFFERENT lockstep from the perm-gate test lists: perm-gated routes need NO edits to `route-protection.ts` AUTH_ONLY_ROUTES or the `expected`/public-prefix sets in `rbac-route-matrix.test.ts` (those are only for auth-only and markPublic routers). They DO still trip this audit-doc gate.
