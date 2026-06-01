---
name: AUTH_ONLY route lockstep
description: Adding an auth-only (no-permission-gate) route requires editing TWO places in lockstep or rbac-test fails.
---

Adding a route that is authenticated-but-not-permission-gated (personal/per-user
endpoints any logged-in user including viewer can hit) requires changes in lockstep:

1. Add each route to `AUTH_ONLY_ROUTES` in `artifacts/api-server/src/lib/route-protection.ts`
   (entries formatted `"<router> <METHOD> <path>"`, e.g. `"favorites POST /bulk"`).
   Without this, `validateRouteTable` flags the route as an *unprotected leak* and the
   boot-time route policy report / rbac-route-matrix fails.
2. Mount the router via `labelRouter(router, "<name>")` in `routes/index.ts` so the
   router gets a label (otherwise it shows up as `(root)` in the matrix).
3. Add the SAME entries to the hardcoded `expectedAuthOnly` array in
   `artifacts/api-server/src/lib/__tests__/rbac-route-matrix.test.ts` (kept
   alphabetically sorted). This is a deliberate review gate — the test asserts the
   live auth-only set deep-equals the hardcoded list, so any auth-only addition fails
   `rbac-test` until a human explicitly acknowledges it here.
4. Regenerate the audit doc headline + Section 11 table via the dump-route-matrix
   script so the headline-count test passes too.

**Why:** the system intentionally treats "authenticated but ungated" as a privileged
exception that must be explicitly allowlisted in BOTH the policy source and the test,
so no route silently bypasses the permission matrix.

**How to apply:** any new per-user/personal route (favorites-style). Permission-gated
routes do NOT touch AUTH_ONLY_ROUTES — they get a `requirePermission` gate instead.
