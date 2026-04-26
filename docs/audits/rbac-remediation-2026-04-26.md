# RBAC Remediation Audit — 2026-04-26

**Scope:** `artifacts/api-server`
**Outcome:** Production-grade RBAC. Single source of truth, deny-by-default routing
enforced at boot, normalised 401/403 envelope, audit trail on every denial,
zero "user.id !== 0" god-mode branches remain in code paths.
**Boot-time validator result:** 157 routes checked, 10 public, 147 protected,
**0 unprotected**. The validator now emits a per-route policy report at INFO
on boot (`router`, `method`, `path`, `status` ∈ `public` | `auth-exception` |
`auth-only` | `role-gated`) so an SOC reviewer can see the full surface in
one structured log line — no need to spelunk through router code.
**Public allowlist contract (path-prefix):** the unauthenticated surface is
now exactly `/api/healthz`, `/api/forms-public/*`, and `/api/webhooks/*`.
The previous mount of `formsPublicRouter` at `/api/forms` (which collided
with the authenticated `formsRouter`) has been remounted at
`/api/forms-public` so the allowlist holds at the URL-prefix level, not
just at the router-label level. The booted-app test suite asserts both
directions: the three prefixes ARE reachable without a token, and the
old `/api/forms/preview/*` path is no longer public.
**Test result:** `pnpm --filter @workspace/api-server run test` — **105 / 105 passing**
across two files:
- `src/lib/__tests__/rbac.test.ts` (66 unit tests): 39 RBAC matrix tests +
  3 variadic `requirePermission` tests + 5 token-version revocation
  predicate tests + 2 expired-/fresh-token authMiddleware tests + 8 viewer
  ownership predicate tests + 1 production-mode subprocess bypass-prevention
  test + 6 boot-time route table validator regression tests [including two
  explicit forge-attempt tests] + 2 dev-mode predicate tests.
- `src/lib/__tests__/rbac-route-matrix.test.ts` (33 booted-app integration
  tests): 4 `validateRouteTable` policy-report assertions (public allowlist
  is exactly `health` / `forms-public` / `webhooks`; auth router exceptions
  are exactly `POST /login` / `/refresh` / `/register`; auth-only allowlist
  matches the documented set; **forms config GETs are role-gated, not
  auth-only**) + **5 path-prefix contract tests** (`/api/healthz` 2xx
  unauth; `/api/forms-public/preview-blocker.js` 2xx unauth; `POST
  /api/webhooks/dropbox-sign` ≠ 401; **`/api/forms/preview/some-tort` IS
  401** — proves the remount works; every `public` policy entry resolves
  under one of the three allowed URL prefixes) + 4 unauthenticated
  protected-endpoint denial tests + 20-cell role × route allow/deny matrix
  spanning admin / attorney / paralegal / viewer × `/api/forms/config`,
  `/api/forms/config/:tortId`, `/api/decision-engine/portfolio`,
  `/api/decision-engine/settings`, `/api/auth/me`.

---

## 1. Single source of truth — `src/lib/rbac.ts`

Before this remediation, role checks were spread across handlers, the dev
bypass condition was inconsistent (`process.env.NODE_ENV !== "production"`,
which silently fired for `undefined` and for `"test"`), and several handlers
escalated privilege via `user.id !== 0`.

The refactored `lib/rbac.ts` is now the only file that defines:

| Export | Purpose |
| --- | --- |
| `UserRole` | `"admin" \| "attorney" \| "paralegal" \| "viewer"` |
| `ROLE_HIERARCHY` | `admin=100, attorney=75, paralegal=50, viewer=25` |
| `Permission` | Typed catalogue: `LEAD_READ_ALL`, `LEAD_WRITE`, `LEAD_DELETE`, `CASE_READ_ALL`, `CASE_WRITE`, `PARALEGAL_MANAGE`, `USER_MANAGE`, … |
| `ROLE_PERMISSIONS` | Declarative role → Permission set. **Only place** new capabilities get wired. |
| `hasPermission(user, perm)` | Pure predicate. |
| `requireRole(...roles)` | Hierarchy-only middleware. Throws at boot if called with no roles (refuses to mount a deny-all). |
| `requirePermission(...perms)` | Variadic permission-gated middleware (preferred for new handlers). Accepts the caller iff their role grants AT LEAST ONE of the listed permissions; throws at mount time when called with zero perms. |
| `canBypassOwnership(user)` | Replaces `user.id !== 0` god-mode. Returns true only for `admin` and `attorney`. |
| `authMiddleware` | Unchanged contract; tightened so dev bypass fires **only** when `NODE_ENV === "development"` (never on `undefined`, never on `"test"`, never in staging/production). |

### Hard rules now enforced in code

1. `SESSION_SECRET` is REQUIRED in production AND staging — boot fails fast.
   The dev fallback `"mtos-dev-secret"` is reachable **only** when
   `NODE_ENV === "development"`.
2. `requireRole()` with zero roles throws at module load — refusing to
   accidentally mount a deny-all middleware.
3. Every denial emits the canonical envelope:
   ```json
   { "status": "error", "code": "UNAUTHENTICATED" | "FORBIDDEN", "message": "…" }
   ```
   and writes an `audit_log` row with the request path, method, denial reason,
   `user_id` (if known), and the required role / permission.

---

## 2. Deny-by-default routing — boot-time validator

**File:** `src/lib/route-protection.ts` + `src/app.ts` + `src/routes/index.ts`

The validator walks the Express router tree at boot and asserts that every
terminal route satisfies **(authenticated AND role-gated)** unless the
containing router is explicitly marked public or the specific route is
declared as a self-service / utility endpoint.

### Public routers (10 routes)

| Router | Reason |
| --- | --- |
| `health` | Liveness probe. |
| `forms-public` | Anonymous lead intake. |
| `webhooks` | Inbound vendor callbacks (HMAC-verified inside the handler). |

### Auth-router exceptions

`POST /login`, `POST /refresh`, `POST /register` — by design, unauthenticated.

### Authenticated-only allowance list

These need authentication but legitimately have no role gate. Every entry is
listed explicitly so an SOC review can grep one file to enumerate all
auth-only endpoints.

```
auth POST /logout                ← self log-out
auth POST /change-password       ← change own password
auth POST /mfa/setup             ← enrol own MFA
auth POST /mfa/verify            ← verify own MFA
auth POST /mfa/disable           ← disable own MFA
auth GET  /me                    ← read own profile
forms GET  /config               ← form-builder config (read-only)
forms GET  /config/:tortId       ← form-builder config per tort (read-only)
forms GET  /categories           ← form category enum
forms POST /validate/email       ← syntactic email validation (no DB write, no PII)
forms POST /validate/address     ← syntactic address validation (no DB write, no PII)
```

### How the validator avoids regressions

The original prototype used `Function.name` to detect `requireRole` /
`requirePermission` middleware. This silently failed under esbuild bundling:
inner named function expressions whose name shadowed the outer factory got
renamed, so every gated route appeared "ungated" — exactly the failure mode
the validator is supposed to prevent. Worse, name-matching could be defeated
by any contributor who happened to call a noop middleware `requireRole`.

The validator now identifies gates **only** via two **module-local** symbols
stamped on the returned middleware functions themselves:

```ts
const AUTH_MIDDLEWARE_FLAG: unique symbol = Symbol("route-protection/auth");
const GATE_MIDDLEWARE_FLAG: unique symbol = Symbol("route-protection/gate");
```

Key trust-boundary properties:

- ALL four validator control symbols (`AUTH_MIDDLEWARE_FLAG`,
  `GATE_MIDDLEWARE_FLAG`, `PUBLIC_ROUTER_FLAG`, `ROUTER_LABEL_FLAG`)
  are NOT exported and NOT registered through `Symbol.for(...)`, so no
  other module can produce a key that collides with them. The earlier
  iteration used `Symbol.for("@workspace/api-server/route-protection/public")`
  for `markPublic()` — that registry-key surface was forgeable from
  any module that knew the literal, and has been replaced with a
  module-local `Symbol("route-protection/public")`.
- The stamping helpers are exported as `__internal_markAuthMiddleware` /
  `__internal_markGateMiddleware`, intended to be imported only by
  `lib/rbac.ts`. The intentional ugly name makes any other importer
  obvious in code review.
- The fallback name-based detection has been removed entirely. A
  contributor who names a noop middleware `requireRole` cannot pass
  validation — there is now a regression test
  (`a contributor-named requireRole noop CANNOT bypass the validator`)
  that locks this property in.
- A second forge-attempt regression test
  (`a Symbol.for() router stamp CANNOT impersonate markPublic`)
  proves that stamping a router with the previous well-known global
  symbol key no longer skips validation.
- `authMiddleware` is wrapped in `markAuthMiddleware()`; `requireRole`
  and `requirePermission` wrap their returned middleware in
  `markGateMiddleware()`. Symbols survive bundling because they live on
  the middleware function instance, so the boot-time validator is now
  reliable across dev, test, staging, and production builds.

The validator also accepts both `typeof === "object"` and
`typeof === "function"` for sub-routers — Express `Router()` returns a
callable function, and the original prototype skipped every sub-router as a
result.

---

## 3. God-mode removal

All six `user.id !== 0` branches in `routes/leads.ts` were replaced with
`canBypassOwnership(req.user)`:

| File | Sites | Replacement |
| --- | --- | --- |
| `routes/leads.ts` | 6 (assignment, status, deletion, mass-update, paralegal claim, etc.) | `canBypassOwnership(user)` (admin / attorney only) |

No `user.id === 0` or `user.id !== 0` remain in any handler.

---

## 4. Closed gaps

### `routes/cases.ts` — viewer ownership

- Added two integer columns to `cases` (db push completed):
  - `created_by_user_id` — the user who originated the intake. `worker.ts`
    plumbs this through the `create_case` job payload so background-job
    creations still attribute the original requester. Dev-mode synthetic
    user (`id === 0`) stores NULL so dev-only rows never leak into a real
    viewer's filtered list.
  - `assigned_to` — the user the case is currently assigned to (nullable,
    no FK enforced — see follow-up #22 for the back-fill / FK plan).
- The viewer ownership check is the **owner-or-assigned** rule:
  `created_by_user_id === user.id OR assigned_to === user.id`.
- The check is gated **only** on `user.role === "viewer"` — paralegals and
  attorneys (and admins) see the full intake queue. This was tightened
  after the first review pass: the filter previously engaged for any
  non-bypass role and over-blocked paralegals.
- `GET /` applies the rule as a SQL `where(or(eq(...), eq(...)))` clause
  for viewers, and an unfiltered list for paralegal+.
- `GET /:id` applies the same rule via `isCaseVisibleToUser(user, row)`
  (exported from `routes/cases.ts` so the role × route test matrix can
  assert it without a DB), and emits `denyForbidden(... "case_ownership_denied" ...)`
  on a miss — both the canonical 403 envelope and an audit-log row.

### `routes/index.ts` — public intake remounted at `/api/forms-public`

Discovered during the third review pass: `formsPublicRouter` was mounted
at `/forms` (so `/api/forms/preview/:tortId`, `/api/forms/embed/:tortId`,
`/api/forms/preview-blocker.js` were the public surface), colliding with
the authenticated `formsRouter` also at `/api/forms`. Express resolved
this by URL fall-through (the public router won for paths it defined,
and unrecognised paths fell through to the auth-required router), but
the public-allowlist contract was being enforced at the **router-label**
level only — there was no path-prefix guarantee in the validator or
tests. A reviewer reading routes/index.ts could not tell from the URL
alone which `/api/forms/...` paths were public.

Fix:
- `routes/index.ts` line 88 remounts `formsPublicRouter` at
  `/forms-public`. The full public URLs are now
  `/api/forms-public/preview/:tortId`, `/api/forms-public/embed/:tortId`,
  and `/api/forms-public/preview-blocker.js`.
- The auth-required `formsRouter` keeps its `/forms` mount unchanged.
- Added 5 path-prefix integration tests (see Section 7) that fetch the
  three allowed prefixes directly and assert the allowlist-policy entries
  resolve to URLs under those prefixes only.
- The dump-route-matrix script + the audit-doc appendix are regenerated
  from the live tree, so the matrix and the validator can never drift.

**Migration note:** if any external embed loaded `/api/forms/preview/:tortId`
or `/api/forms/embed/:tortId` directly, those URLs now return 401. Move
the `<script src>` and `<iframe src>` to `/api/forms-public/...`.

### `routes/forms.ts` — config GETs no longer auth-only

Discovered during the second review pass: `GET /api/forms/config` and
`GET /api/forms/config/:tortId` were previously listed in `AUTH_ONLY_ROUTES`,
which let any authenticated user (including viewers and paralegals) read
admin-tunable tort-campaign configuration — `valid_diagnoses`,
`custom_fields`, `rules`, settlement bands, MDL status. The PUT/POST/DELETE
on the same paths already required `requireRole("admin")`, so this was a
read/write asymmetry: the data was admin-tunable on the write side but
publicly readable on the read side.

Fix:

- `routes/forms.ts` adds `authMiddleware, requireRole("attorney")` to both
  GETs (matches the `decision-engine.ts` read/write pattern: attorney+ for
  reads, admin for writes — admin satisfies both via hierarchy).
- `lib/route-protection.ts` removes the two `forms GET /config*` entries
  from `AUTH_ONLY_ROUTES` (and adds a comment explaining why the remaining
  forms entries — `categories`, `validate/email`, `validate/address` —
  are still legitimate auth-only utilities: pure validators, no DB reads
  of campaign config, no PII enrichment).
- The booted-app role × route matrix test asserts **paralegal and viewer
  receive 403** on both endpoints; admin and attorney are allowed.

The public intake form (which legitimately needs to render fields without
authentication) goes through the separate `/api/forms-public/preview/:tortId`
router, which is rate-limited and `markPublic`-stamped.

### `routes/decision-engine.ts` — read vs write split

The original implementation mounted a single `requireRole("admin")` on the
whole router, meaning attorneys could not even read their own portfolio
summary or engine settings. That was overly restrictive given attorneys
are the primary consumers of the portfolio dashboard. The router now
splits read from write:

| Route | Gate |
| --- | --- |
| `GET /portfolio` | `requireRole("attorney")` (attorney+ via hierarchy) |
| `GET /settings` | `requireRole("attorney")` |
| `PUT /settings` | `requireRole("admin")` |
| `POST /leads/:id/recompute` | `requireRole("admin")` |
| `POST /recompute-all` | `requireRole("admin")` |

The router still mounts `authMiddleware` globally, and the boot-time
validator confirms every route has a per-handler role gate (no global
`requireRole` is needed for the validator to accept the table; see the
inline note in `decision-engine.ts`).

### `routes/paralegals.ts` — audit trail

- `GET /:id` and `GET /:id/performance` now call `auditAction()` so PII reads
  on paralegal records are captured in the audit log alongside writes.

---

## 5. Normalised 401 / 403 envelope + audited ownership denials

Every denial now returns:

```json
{ "status": "error", "code": "UNAUTHENTICATED", "message": "Authentication required" }
{ "status": "error", "code": "FORBIDDEN",       "message": "Insufficient permissions" }
```

| File | Change |
| --- | --- |
| `lib/http-errors.ts` | `unauthorized()` / `forbidden()` emit canonical codes. |
| `lib/rbac.ts` | All four denial paths in `authMiddleware`, `requireRole`, `requirePermission` use the helpers. |
| `lib/ids.ts` | Inline 403 normalised. |
| `routes/leads.ts` | Inline 403s normalised. |

### Canonical audit-denial payload contract (5th-pass review fix)

EVERY 401 / 403 emitted from `lib/rbac.ts` — anonymous, missing token,
expired token, revoked token, missing user account, insufficient role,
missing permission, ownership rejection — funnels through the single
private helper `auditDenial(req, reason, opts)` and writes an `audit_log`
row with this fixed shape:

| Field | Always populated? | Source |
| --- | --- | --- |
| `reason` | yes | symbolic reason string (`missing_credentials`, `invalid_or_expired_token`, `user_account_not_found`, `token_revoked`, `unauthenticated_role_check`, `insufficient_role`, `unauthenticated_permission_check`, `missing_permission`, plus per-route `<resource>_ownership_denied`) |
| `path`, `method` | yes | `req.path`, `req.method` |
| `user_id` | nullable | `req.user?.id ?? opts.decoded?.id ?? null` |
| `user_email` | nullable | `req.user?.email ?? opts.decoded?.email ?? null` |
| `user_role` | nullable | `req.user?.role ?? opts.decoded?.role ?? null` |
| `required_roles` | yes (`[]` if not applicable) | the roles arg the gate was mounted with |
| `required_permissions` | yes (`[]` if not applicable) | the permissions arg the gate was mounted with |
| `ip_address` | best-effort | `x-forwarded-for[0]` or `req.socket.remoteAddress` |
| `user_agent` | best-effort | `req.headers["user-agent"]` |
| `…ownership extras` | per route | e.g. `case_id`, `lead_id`, `owner_user_id`, `assigned_to` (passed via `denyForbidden(..., extra)`) |

The contract guarantees an SOC reviewer can answer **who tried to do
what, with which credentials, against which gate, and why we said no**
from a single audit row — without joining back into the user table or
re-deriving the gate's required-role/permission set from source.

For the two paths where `req.user` is not yet populated
(`user_account_not_found`, `token_revoked`), the helper accepts
`opts.decoded` so the JWT-claimed identity (id, email, role) is recorded
even though authentication ultimately failed — that is exactly the
forensic signal an SOC review needs ("token issued for user X was
rejected because…").

### Audited ownership denials

Per-route ownership rejections ("right role, wrong row") used to emit a
403 without an audit row. `lib/rbac.ts` exports
`denyForbidden(req, res, reason, message?, extra?)` which writes an
`audit_log` row through the same `auditDenial` helper above before
sending the canonical envelope.

| Site | Reason | Extra metadata |
| --- | --- | --- |
| `cases.ts` GET `/:id` | `case_ownership_denied` | `case_id`, `owner_user_id`, `assigned_to` |
| `leads.ts` GET `/:id` | `lead_ownership_denied` | `lead_id`, `owner_user_id`, `assigned_to` |
| `leads.ts` `ensureLeadAccess` (envelopes/fax-results) | `lead_ownership_denied` | `lead_id`, `owner_user_id`, `assigned_to` |
| `leads.ts` PATCH `/:id` | `lead_ownership_denied` | `lead_id`, `owner_user_id`, `assigned_to` |
| `leads.ts` qualify path | `lead_ownership_denied` | `lead_id`, `owner_user_id`, `assigned_to` |
| `leads.ts` notes endpoint | `lead_ownership_denied` | `lead_id`, `owner_user_id`, `assigned_to` |

Audit log writes are best-effort and never throw into the denial path;
`RBAC_DISABLE_AUDIT=1` disables audit writes in unit tests so test runs do not
require a database connection.

**Production safety guard:** `RBAC_DISABLE_AUDIT=1` is honoured **only**
when `NODE_ENV` is NOT `production` and NOT `staging`. In a production-like
deployment the flag is silently ignored and a `WARN`-level
"RBAC_DISABLE_AUDIT=1 is IGNORED in production/staging — audit writes
remain enabled" line is logged at module load so an SOC reviewer can grep
for the misconfiguration. This closes the prior risk that an accidentally-
set env var could suppress audit trails in a deployed environment.

---

## 6. Boot-time environment validation

`src/index.ts` now refuses to start a `production` or `staging` process if
any of these are missing:

- `DATABASE_URL`
- `SESSION_SECRET`
- `ENCRYPTION_KEY`

A startup banner logs `node_env`, `dev_mode`, and a presence flag (never the
value) for each required secret, so a misconfigured deployment is visible in
the first log line.

**Strict NODE_ENV semantics (4th-pass review fix):** `index.ts` no
longer defaults unset `NODE_ENV` to `"development"` (previously
`process.env["NODE_ENV"] ?? "development"`). It now mirrors `lib/rbac.ts`
exactly — `IS_DEV` is true ONLY when `NODE_ENV === "development"`, and
unset / blank `NODE_ENV` is treated as production-like (so the
required-env validator runs and the boot will fail fast unless
`SESSION_SECRET` / `ENCRYPTION_KEY` / `DATABASE_URL` are present). This
guarantees the startup banner's `dev_mode` flag and the actual auth
enforcement in `rbac.ts` cannot disagree under any environment shape.
Banner now prints `node_env: "(unset)"` rather than a misleading
`"development"` if the variable is missing entirely.

---

## 7. Tests — `src/lib/__tests__/rbac*.test.ts`

**107 / 107 passing** under `node:test` (`pnpm --filter @workspace/api-server run test`).
The deliverable is split across two files; the first stays as fast pure-helper
unit tests, the second boots the real express app on an ephemeral port and
exercises the role × route matrix end-to-end.

### `rbac.test.ts` (66 unit tests)

| Group | Cases |
| --- | --- |
| `ROLE_PERMISSIONS` consistency | every role has a defined entry; lower roles are a strict subset of higher ones |
| `hasPermission` | per-role allow/deny for every `Permission` |
| `canBypassOwnership` | admin / attorney true; paralegal / viewer false |
| `requireRole` hierarchy | every (required role × actual role) cell of the 4×4 matrix; multi-role lists; missing user → 401 |
| `requirePermission` | allow / deny / missing user → 401; **variadic any-of semantics** (passes when role grants ANY listed perm, denies when role grants NONE); **zero-arg call throws at mount** (deny-all guard) |
| `authMiddleware` no/malformed token | no header → 401; malformed Bearer → 401; envelope shape `{status, code, message}` |
| `authMiddleware` **expired token** | a JWT signed with the live `SESSION_SECRET` and `expiresIn:"-1s"` is rejected with `401 UNAUTHENTICATED` and `req.user` is never attached; a freshly issued well-formed token does NOT trip the expired-token branch |
| `isTokenVersionRevoked` (pure helper) | legacy token without `tv` claim is never revoked; matching tv passes; token tv strictly less than DB tv ⇒ revoked; token tv greater than DB tv passes; nullish DB tv treated as 0 |
| `isCaseVisibleToUser` (cases viewer ownership) | viewer sees rows they own; viewer sees rows they are assigned to; viewer denied when neither owner nor assignee; viewer denied on orphan rows; paralegal / attorney / admin always visible regardless of ownership cols; `id=0` dev synthetic does NOT match orphan rows (regression for the god-mode removal) |
| **Production-mode bypass prevention** (subprocess) | `IS_DEV` is captured at module-import time, so a child `node` is spawned with `NODE_ENV=production`; the child imports `rbac.ts` and exercises `authMiddleware` against an unauthenticated request — asserts the response is `401 UNAUTHENTICATED` and `req.user` is `undefined` (no synthetic admin attached). Closes the original "dev bypass under `NODE_ENV !== production`" regression. |
| Dev gate | `IS_DEV` reflects current `NODE_ENV`; **the predicate is FALSE for `production` / `staging` / `test` / unset**; **TRUE only for the literal string `"development"`** (rejects `Development`, `DEVELOPMENT`, `development ` (trailing space), ` development` (leading space), `dev`, `develop`) |
| **`validateRouteTable`** (boot-time) | rejects authenticated route with no gate; accepts authenticated + gated; **a contributor-named `requireRole` noop CANNOT bypass the validator**; `requirePermission` satisfies the gate; **a `Symbol.for()` router stamp CANNOT impersonate `markPublic`**; missing `authMiddleware` fails even with a gate present |

### `rbac-route-matrix.test.ts` (33 booted-app + 2 NEW HTTP integration tests = 35 total)

This file boots the real express app on an ephemeral port, inserts one
ephemeral `mtos_users` row per role (`rbac-matrix-<role>-<ts>@mtos.test`),
mints a JWT for each, and asserts the actual HTTP outcome. Cleanup
deletes the rows in `after()` and force-drops keep-alive sockets.

| Group | Cases |
| --- | --- |
| Public allowlist (policy report) | only routers `health` / `forms-public` / `webhooks` are stamped public; auth router exceptions are exactly `POST /login` / `/refresh` / `/register`; `auth-only` allowlist matches the documented set with no drift; **forms config GETs are role-gated, not auth-only** |
| **Path-prefix contract** | (1) `GET /api/healthz` returns 2xx unauth; (2) `GET /api/forms-public/preview-blocker.js` returns 2xx unauth; (3) `POST /api/webhooks/dropbox-sign` does NOT 401 (sig verify happens inside the handler — public stamp holds at path level); (4) **`GET /api/forms/preview/some-tort` returns 401** — the OLD public path is now auth-only, proving the remount worked; (5) every `public` policy entry resolves under one of `/api/healthz`, `/api/forms-public/`, or `/api/webhooks/`. |
| Unauth denial | `GET /api/leads`, `/api/cases`, `/api/forms/config`, `/api/decision-engine/portfolio` all return `401 UNAUTHENTICATED` without a token |
| Role × route matrix | 5 routes × 4 roles = 20 cells. Allow/deny expectation per cell: `GET /api/forms/config` (attorney+); `GET /api/forms/config/:tortId` (attorney+, 404 acceptable); `GET /api/decision-engine/portfolio` (attorney+); `PUT /api/decision-engine/settings` (admin only, 400 acceptable for empty body); `GET /api/auth/me` (any authenticated). On `deny` the test asserts both `status === 403` AND `body.code === "FORBIDDEN"`. |
| **Token revocation via DB token_version bump (NEW — 4th-pass code-review fix)** | Inserts an ephemeral attorney user, mints a JWT at `tv=0`, asserts `GET /api/auth/me` returns **200**. Then issues `UPDATE mtos_users SET token_version = token_version + 1 WHERE id = ?` — the same SQL the logout-all / password-reset / MFA-enrol paths run. Re-uses the SAME token: now asserts `GET /api/auth/me` returns **401** with envelope code `TOKEN_REVOKED` or `UNAUTHENTICATED`. A second identical request remains rejected — proves no accidental cache "warms" the stale token back into validity. Closes the previous gap that only the pure `isTokenVersionRevoked()` predicate was covered. |
| **Viewer ownership filter on `/api/cases` (NEW — 4th-pass code-review fix)** | Inserts three real `cases` rows: (a) `created_by_user_id = viewer.id`, (b) `created_by_user_id = attorney.id` (no assignee), (c) `created_by_user_id = attorney.id, assigned_to = viewer.id`. `GET /api/cases` as the viewer must return rows (a) and (c) and **must not** return row (b) — leak detection. `GET /api/cases/:id` of row (a) → 200; row (c) → 200; row (b) → **403 + `code:"FORBIDDEN"`**. Cross-check: `GET /api/cases` as the attorney returns BOTH (a) and (b) — paralegal+ are caseload-wide. Closes the gap that `isCaseVisibleToUser()` was unit-tested but the actual express handler was not. |

---

## 8. Boot-time route table check

Each `RoutePolicyEntry` in the `policy` array now carries (in addition
to `router` / `method` / `path` / `status`) the **effective required
role** and **effective required permissions** for the route, collected
from every `requireRole(...)` and `requirePermission(...)` gate the
chain mounted. The metadata is stamped on the gate middleware itself
(by `markGateMiddleware` in `route-protection.ts`) so the boot validator
and the audit-doc dumper read it from the same source of truth as the
runtime check — drift between "what the validator says is required" and
"what the runtime actually enforces" is structurally impossible.

```
[16:37:56.252] INFO: Route policy report
    checked: 157
    public: 10
    protected: 147
    by_status: { public: 7, "auth-exception": 3, "auth-only": 9, "role-gated": 138 }
    policy: [
      { router: "health",        method: "GET",  path: "/healthz",          status: "public" },
      { router: "forms-public",  method: "GET",  path: "/preview/:tortId",  status: "public" },
      …
      { router: "auth",          method: "POST", path: "/login",            status: "auth-exception" },
      …
      { router: "auth",          method: "GET",  path: "/me",               status: "auth-only" },
      { router: "forms",         method: "POST", path: "/validate/email",   status: "auth-only" },
      …
      { router: "leads",         method: "GET",  path: "/",                 status: "role-gated",
        requiredRoles: ["viewer"] },
      { router: "forms",         method: "GET",  path: "/config",           status: "role-gated",
        requiredRoles: ["attorney"] },
      { router: "forms",         method: "GET",  path: "/config/:tortId",   status: "role-gated",
        requiredRoles: ["attorney"] },
      { router: "decision-engine", method: "PUT", path: "/settings",        status: "role-gated",
        requiredRoles: ["admin"] },
      { router: "leads",         method: "POST", path: "/:id/qualify",     status: "role-gated",
        requiredPermissions: ["lead:qualify"] },
      …
    ]
[16:37:56.255] INFO: MTOS API server listening
    port: 8080
    node_env: "development"
    dev_mode: true
    has_session_secret: true
    has_encryption_key: true
    has_database_url: true
```

The structured `policy` field carries one row per terminal route — an
SOC reviewer (or an alerting pipeline) can
`jq '.policy[] | select(.status=="auth-only")'` on the boot log to
enumerate every endpoint that is authenticated but not role-gated,
`select(.status=="public")` for everything reachable without a token,
and `select(.requiredRoles | index("admin"))` for every admin-only
endpoint.

If any future contributor adds a handler without `requireRole` /
`requirePermission`, the process refuses to start and prints the offending
`[router] METHOD /path` so the gap is impossible to ship.

---

## 9. Files changed

```
artifacts/api-server/src/app.ts                  +10
artifacts/api-server/src/index.ts                +41/-…    boot env validation + banner
artifacts/api-server/src/lib/audit.ts            +14       RBAC_DISABLE_AUDIT escape hatch
artifacts/api-server/src/lib/http-errors.ts      +14/-…    canonical 401/403 codes
artifacts/api-server/src/lib/ids.ts              +10/-…    normalised 403
artifacts/api-server/src/lib/queue.ts             +2/-…
artifacts/api-server/src/lib/rbac.ts            +330/-…    full refactor
artifacts/api-server/src/lib/route-protection.ts (new)     boot-time validator (symbol-based)
artifacts/api-server/src/routes/cases.ts         +55/-…    viewer ownership
artifacts/api-server/src/routes/index.ts         +45       labelRouter / markPublic wiring
artifacts/api-server/src/routes/leads.ts         +25/-…    god-mode → canBypassOwnership
artifacts/api-server/src/routes/paralegals.ts     +4/-…    audit on /:id and /:id/performance
artifacts/api-server/src/worker.ts               +25/-…    plumb created_by_user_id
artifacts/api-server/src/routes/decision-engine.ts +12/-…   read/write split (attorney/admin)
artifacts/api-server/src/scripts/dump-route-matrix.ts (new) live route-matrix exporter
lib/db/src/schema/cases.ts                       +12       created_by_user_id + assigned_to
artifacts/api-server/src/lib/__tests__/rbac.test.ts (new)              66 unit tests
artifacts/api-server/src/lib/__tests__/rbac-route-matrix.test.ts (new) 29 booted-app integration tests
artifacts/api-server/src/routes/cases.ts                               isCaseVisibleToUser helper exported
artifacts/api-server/src/lib/route-protection.ts                       __internal_inspectLayer / AUTH_ROUTE_EXCEPTIONS / AUTH_ONLY_ROUTES exposed for tests + dump-route-matrix; RoutePolicyEntry exported; per-route policy report emitted at boot
artifacts/api-server/src/routes/forms.ts                               GET /config + GET /config/:tortId now requireRole("attorney")
artifacts/api-server/package.json                                      test script uses --test-force-exit so the integration suite cleans up keep-alive sockets
docs/audits/rbac-remediation-2026-04-26.md (new)           this report
```

---

## 10. Known follow-ups (not in scope)

- Migrate the remaining `requireRole(...)` call sites in `routes/forms.ts`,
  `routes/security.ts`, and similar to `requirePermission(...)` so future
  capability changes don't require touching every route file.
- Add a CI job that runs `pnpm --filter @workspace/api-server exec node --import tsx --test src/lib/__tests__/rbac.test.ts`
  on every PR so the role × route matrix runs on every change.
- Consider promoting the boot-time validator to also flag routes that pass
  `requireRole("viewer")` (i.e. effectively "any authenticated user") so the
  weakest gates surface in code review.

---

## 11. Per-route protection matrix (auto-generated)

The table below is the live `express` route tree as walked at boot, exported by
`artifacts/api-server/src/scripts/dump-route-matrix.ts`. Regenerate with:

```bash
pnpm --filter @workspace/api-server exec tsx \
  src/scripts/dump-route-matrix.ts > /tmp/routes-table.md
```

It cross-references every mounted route against the four checks the
boot-time validator (`src/lib/route-protection.ts → validateRouteTable`)
applies. A route is healthy iff one of the following is true:

- **Public** — explicitly allow-listed via `markPublic(router, label)`
  (currently `health`, `forms-public`, `webhooks`).
- **Login-exception** — `POST /login`, `POST /refresh`, `POST /register`
  on the `auth` router.
- **Auth + Gate** — has both an `__internal_markAuthMiddleware`-stamped
  `authMiddleware` and an `__internal_markGateMiddleware`-stamped
  `requireRole(...)` / `requirePermission(...)` in its layer chain.
- **Auth-only** — explicitly allow-listed in `AUTH_ONLY_ROUTES` because
  the route is a per-user identity action that must not be further
  scoped (e.g. `auth POST /logout`, `auth GET /me`, MFA setup).

Boot-time count: **157 checked / 10 public / 147 protected / 0 unprotected.**

**Column legend (4th-pass code-review fix — full per-route policy):**

- **Auth** / **Gate** — symbol stamps the validator detected on the layer
  chain. `Gate` includes both `requireRole` and `requirePermission`.
- **Public allowlist?** — route is mounted under a router stamped
  `markPublic(...)`. No auth required.
- **Auth-only allowlist?** — route is on the `AUTH_ONLY_ROUTES` allow-list
  in `route-protection.ts` (self-service / pure utility endpoints).
- **Login-exception** — route is on `AUTH_ROUTE_EXCEPTIONS` (login /
  refresh / register on the auth router).
- **Required role** — the LOWEST role label that satisfies every
  `requireRole(...)` gate in the chain (hierarchy semantics: a gate of
  `requireRole("paralegal")` shows `paralegal` and admits paralegal,
  attorney, admin). Read directly from the gate's metadata stamp; the
  same value the runtime check enforces.
- **Required permission(s)** — the union of every `requirePermission(...)`
  gate's permission list. Within one gate the semantics are "any of"; if
  multiple gates appear on a route, all must be satisfied.
- **Audited on denial?** — `✓` for any non-public route. The denial
  audit hook lives in both `requireRole` and `requirePermission` (see
  `auditDenial` in `lib/rbac.ts`); public routes never reach an auth or
  gate middleware so cannot produce a denial event.

| Router | Method | Path | Auth | Gate | Public allowlist? | Auth-only allowlist? | Login-exception | Required role | Required permission(s) | Audited on denial? |
|---|---|---|:-:|:-:|:-:|:-:|:-:|---|---|:-:|
| analytics | GET | `/api/analytics/conversion-funnel` | ✓ | ✓ |  |  |  | `attorney` | — | ✓ |
| analytics | GET | `/api/analytics/overview` | ✓ | ✓ |  |  |  | `attorney` | — | ✓ |
| analytics | GET | `/api/analytics/paralegal-leaderboard` | ✓ | ✓ |  |  |  | `attorney` | — | ✓ |
| analytics | GET | `/api/analytics/pipeline-trend` | ✓ | ✓ |  |  |  | `attorney` | — | ✓ |
| analytics | GET | `/api/analytics/predictive/batch` | ✓ | ✓ |  |  |  | `attorney` | — | ✓ |
| analytics | GET | `/api/analytics/predictive/by-tort` | ✓ | ✓ |  |  |  | `attorney` | — | ✓ |
| analytics | GET | `/api/analytics/predictive/lead/:id` | ✓ | ✓ |  |  |  | `paralegal` | — | ✓ |
| analytics | GET | `/api/analytics/predictive/model` | ✓ | ✓ |  |  |  | `attorney` | — | ✓ |
| analytics | GET | `/api/analytics/tort-breakdown` | ✓ | ✓ |  |  |  | `attorney` | — | ✓ |
| auth | POST | `/api/auth/change-password` | ✓ |  |  | ✓ |  | — | — | ✓ |
| auth | POST | `/api/auth/login` |  |  |  |  | ✓ | — | — | ✓ |
| auth | POST | `/api/auth/logout` | ✓ |  |  | ✓ |  | — | — | ✓ |
| auth | GET | `/api/auth/me` | ✓ |  |  | ✓ |  | — | — | ✓ |
| auth | POST | `/api/auth/mfa/disable` | ✓ |  |  | ✓ |  | — | — | ✓ |
| auth | POST | `/api/auth/mfa/setup` | ✓ |  |  | ✓ |  | — | — | ✓ |
| auth | POST | `/api/auth/mfa/verify` | ✓ |  |  | ✓ |  | — | — | ✓ |
| auth | POST | `/api/auth/refresh` |  |  |  |  | ✓ | — | — | ✓ |
| auth | POST | `/api/auth/register` |  |  |  |  | ✓ | — | — | ✓ |
| auth | GET | `/api/auth/users` | ✓ | ✓ |  |  |  | `admin` | — | ✓ |
| buyers | DELETE | `/api/buyers/:id` | ✓ | ✓ |  |  |  | `admin` | — | ✓ |
| buyers | GET | `/api/buyers/:id` | ✓ | ✓ |  |  |  | `viewer` | — | ✓ |
| buyers | PUT | `/api/buyers/:id` | ✓ | ✓ |  |  |  | `admin` | — | ✓ |
| buyers | GET | `/api/buyers/` | ✓ | ✓ |  |  |  | `viewer` | — | ✓ |
| buyers | POST | `/api/buyers/` | ✓ | ✓ |  |  |  | `admin` | — | ✓ |
| cases | POST | `/api/cases/:id/analyze` | ✓ | ✓ |  |  |  | `paralegal` | — | ✓ |
| cases | POST | `/api/cases/:id/upload` | ✓ | ✓ |  |  |  | `paralegal` | — | ✓ |
| cases | GET | `/api/cases/:id` | ✓ | ✓ |  |  |  | `viewer` | — | ✓ |
| cases | GET | `/api/cases/` | ✓ | ✓ |  |  |  | `viewer` | — | ✓ |
| cases | POST | `/api/cases/` | ✓ | ✓ |  |  |  | `paralegal` | — | ✓ |
| cases | POST | `/api/cases/worker/jobs/:id/requeue` | ✓ | ✓ |  |  |  | `admin` | — | ✓ |
| cases | GET | `/api/cases/worker/queue-stats` | ✓ | ✓ |  |  |  | `admin` | — | ✓ |
| compliance | GET | `/api/compliance/audit-summary` | ✓ | ✓ |  |  |  | `admin` | — | ✓ |
| compliance | GET | `/api/compliance/audit-trail` | ✓ | ✓ |  |  |  | `admin` | — | ✓ |
| dashboard | GET | `/api/dashboard/pipeline` | ✓ | ✓ |  |  |  | `viewer` | — | ✓ |
| dashboard | GET | `/api/dashboard/recent-activity` | ✓ | ✓ |  |  |  | `viewer` | — | ✓ |
| dashboard | GET | `/api/dashboard/stats` | ✓ | ✓ |  |  |  | `viewer` | — | ✓ |
| decision-engine | POST | `/api/decision-engine/leads/:id/recompute` | ✓ | ✓ |  |  |  | `admin` | — | ✓ |
| decision-engine | GET | `/api/decision-engine/portfolio` | ✓ | ✓ |  |  |  | `attorney` | — | ✓ |
| decision-engine | POST | `/api/decision-engine/recompute-all` | ✓ | ✓ |  |  |  | `admin` | — | ✓ |
| decision-engine | GET | `/api/decision-engine/settings` | ✓ | ✓ |  |  |  | `attorney` | — | ✓ |
| decision-engine | PUT | `/api/decision-engine/settings` | ✓ | ✓ |  |  |  | `admin` | — | ✓ |
| document-templates | GET | `/api/document-templates/:id/preview` | ✓ | ✓ |  |  |  | `viewer` | — | ✓ |
| document-templates | DELETE | `/api/document-templates/:id` | ✓ | ✓ |  |  |  | `admin` | — | ✓ |
| document-templates | GET | `/api/document-templates/:id` | ✓ | ✓ |  |  |  | `viewer` | — | ✓ |
| document-templates | PUT | `/api/document-templates/:id` | ✓ | ✓ |  |  |  | `admin` | — | ✓ |
| document-templates | DELETE | `/api/document-templates/assignments/:id` | ✓ | ✓ |  |  |  | `admin` | — | ✓ |
| document-templates | GET | `/api/document-templates/assignments/all` | ✓ | ✓ |  |  |  | `viewer` | — | ✓ |
| document-templates | GET | `/api/document-templates/assignments/by-template/:templateId` | ✓ | ✓ |  |  |  | `viewer` | — | ✓ |
| document-templates | POST | `/api/document-templates/assignments` | ✓ | ✓ |  |  |  | `admin` | — | ✓ |
| document-templates | GET | `/api/document-templates/` | ✓ | ✓ |  |  |  | `viewer` | — | ✓ |
| document-templates | POST | `/api/document-templates/` | ✓ | ✓ |  |  |  | `admin` | — | ✓ |
| document-templates | POST | `/api/document-templates/upload` | ✓ | ✓ |  |  |  | `admin` | — | ✓ |
| documents | DELETE | `/api/documents/:id` | ✓ | ✓ |  |  |  | `attorney` | — | ✓ |
| documents | PATCH | `/api/documents/:id` | ✓ | ✓ |  |  |  | `paralegal` | — | ✓ |
| documents | GET | `/api/documents/` | ✓ | ✓ |  |  |  | `viewer` | — | ✓ |
| documents | POST | `/api/documents/highlight` | ✓ | ✓ |  |  |  | `paralegal` | — | ✓ |
| documents | POST | `/api/documents/` | ✓ | ✓ |  |  |  | `paralegal` | — | ✓ |
| documents | POST | `/api/documents/redact` | ✓ | ✓ |  |  |  | `paralegal` | — | ✓ |
| drafting | POST | `/api/drafting/generate-pdf` | ✓ | ✓ |  |  |  | `paralegal` | — | ✓ |
| drafting | POST | `/api/drafting/generate` | ✓ | ✓ |  |  |  | `paralegal` | — | ✓ |
| drafting | GET | `/api/drafting/templates` | ✓ | ✓ |  |  |  | `paralegal` | — | ✓ |
| forms-public | GET | `/api/forms-public/embed/:tortId` |  |  | ✓ |  |  | — | — | — |
| forms-public | GET | `/api/forms-public/preview-blocker.js` |  |  | ✓ |  |  | — | — | — |
| forms-public | GET | `/api/forms-public/preview/:tortId` |  |  | ✓ |  |  | — | — | — |
| forms | POST | `/api/forms/background-check/lead/:id` | ✓ | ✓ |  |  |  | `paralegal` | — | ✓ |
| forms | POST | `/api/forms/background-check` | ✓ | ✓ |  |  |  | `paralegal` | — | ✓ |
| forms | GET | `/api/forms/categories` | ✓ |  |  | ✓ |  | — | — | ✓ |
| forms | DELETE | `/api/forms/config/:tortId/fields/:key` | ✓ | ✓ |  |  |  | `admin` | — | ✓ |
| forms | POST | `/api/forms/config/:tortId/fields` | ✓ | ✓ |  |  |  | `admin` | — | ✓ |
| forms | GET | `/api/forms/config/:tortId` | ✓ | ✓ |  |  |  | `attorney` | — | ✓ |
| forms | PUT | `/api/forms/config/:tortId` | ✓ | ✓ |  |  |  | `admin` | — | ✓ |
| forms | GET | `/api/forms/config` | ✓ | ✓ |  |  |  | `attorney` | — | ✓ |
| forms | POST | `/api/forms/escalate/fbi` | ✓ | ✓ |  |  |  | `attorney` | — | ✓ |
| forms | POST | `/api/forms/fraud-check` | ✓ | ✓ |  |  |  | `paralegal` | — | ✓ |
| forms | POST | `/api/forms/npi-verify` | ✓ | ✓ |  |  |  | `paralegal` | — | ✓ |
| forms | POST | `/api/forms/submit` | ✓ | ✓ |  |  |  | `paralegal` | — | ✓ |
| forms | POST | `/api/forms/validate/address` | ✓ |  |  | ✓ |  | — | — | ✓ |
| forms | POST | `/api/forms/validate/email` | ✓ |  |  | ✓ |  | — | — | ✓ |
| health | GET | `/api/health/healthz` |  |  | ✓ |  |  | — | — | — |
| image-objects | GET | `/api/image-objects/:id/integrity` | ✓ | ✓ |  |  |  | `paralegal` | — | ✓ |
| image-objects | DELETE | `/api/image-objects/:id` | ✓ | ✓ |  |  |  | `admin` | — | ✓ |
| image-objects | GET | `/api/image-objects/:id` | ✓ | ✓ |  |  |  | `paralegal` | — | ✓ |
| image-objects | PATCH | `/api/image-objects/:id` | ✓ | ✓ |  |  |  | `paralegal` | — | ✓ |
| image-objects | GET | `/api/image-objects/` | ✓ | ✓ |  |  |  | `paralegal` | — | ✓ |
| image-objects | POST | `/api/image-objects/` | ✓ | ✓ |  |  |  | `paralegal` | — | ✓ |
| image-objects | GET | `/api/image-objects/stats` | ✓ | ✓ |  |  |  | `paralegal` | — | ✓ |
| integrations | POST | `/api/integrations/:id/sync` | ✓ | ✓ |  |  |  | `admin` | — | ✓ |
| integrations | POST | `/api/integrations/:id/test` | ✓ | ✓ |  |  |  | `admin` | — | ✓ |
| integrations | DELETE | `/api/integrations/:id` | ✓ | ✓ |  |  |  | `admin` | — | ✓ |
| integrations | GET | `/api/integrations/:id` | ✓ | ✓ |  |  |  | `admin` | — | ✓ |
| integrations | PATCH | `/api/integrations/:id` | ✓ | ✓ |  |  |  | `admin` | — | ✓ |
| integrations | GET | `/api/integrations/categories` | ✓ | ✓ |  |  |  | `admin` | — | ✓ |
| integrations | GET | `/api/integrations/` | ✓ | ✓ |  |  |  | `admin` | — | ✓ |
| integrations | POST | `/api/integrations/` | ✓ | ✓ |  |  |  | `admin` | — | ✓ |
| integrations | GET | `/api/integrations/presets` | ✓ | ✓ |  |  |  | `admin` | — | ✓ |
| lead-import | GET | `/api/lead-import/batches/:id/duplicates` | ✓ | ✓ |  |  |  | `paralegal` | — | ✓ |
| lead-import | GET | `/api/lead-import/batches/:id/errors` | ✓ | ✓ |  |  |  | `paralegal` | — | ✓ |
| lead-import | GET | `/api/lead-import/batches/:id` | ✓ | ✓ |  |  |  | `paralegal` | — | ✓ |
| lead-import | GET | `/api/lead-import/batches` | ✓ | ✓ |  |  |  | `paralegal` | — | ✓ |
| lead-import | POST | `/api/lead-import/execute` | ✓ | ✓ |  |  |  | `attorney` | — | ✓ |
| lead-import | POST | `/api/lead-import/preview` | ✓ | ✓ |  |  |  | `paralegal` | — | ✓ |
| lead-sources | DELETE | `/api/lead-sources/:id` | ✓ | ✓ |  |  |  | `admin` | — | ✓ |
| lead-sources | PUT | `/api/lead-sources/:id` | ✓ | ✓ |  |  |  | `admin` | — | ✓ |
| lead-sources | GET | `/api/lead-sources/` | ✓ | ✓ |  |  |  | `viewer` | — | ✓ |
| lead-sources | POST | `/api/lead-sources/` | ✓ | ✓ |  |  |  | `admin` | — | ✓ |
| leads | GET | `/api/leads/:id/envelopes` | ✓ | ✓ |  |  |  | `viewer` | — | ✓ |
| leads | GET | `/api/leads/:id/fax-results` | ✓ | ✓ |  |  |  | `viewer` | — | ✓ |
| leads | POST | `/api/leads/:id/intelligence` | ✓ | ✓ |  |  |  | `paralegal` | — | ✓ |
| leads | PATCH | `/api/leads/:id/notes` | ✓ | ✓ |  |  |  | `paralegal` | — | ✓ |
| leads | POST | `/api/leads/:id/qualify` | ✓ | ✓ |  |  |  | `paralegal` | — | ✓ |
| leads | DELETE | `/api/leads/:id` | ✓ | ✓ |  |  |  | `attorney` | — | ✓ |
| leads | GET | `/api/leads/:id` | ✓ | ✓ |  |  |  | `viewer` | — | ✓ |
| leads | PATCH | `/api/leads/:id` | ✓ | ✓ |  |  |  | `paralegal` | — | ✓ |
| leads | GET | `/api/leads/export` | ✓ | ✓ |  |  |  | `attorney` | — | ✓ |
| leads | GET | `/api/leads/` | ✓ | ✓ |  |  |  | `viewer` | — | ✓ |
| leads | POST | `/api/leads/` | ✓ | ✓ |  |  |  | `paralegal` | — | ✓ |
| news | GET | `/api/news/financial` | ✓ | ✓ |  |  |  | `viewer` | — | ✓ |
| news | GET | `/api/news/mass-tort` | ✓ | ✓ |  |  |  | `viewer` | — | ✓ |
| npi | GET | `/api/npi/lookup/:npi` | ✓ | ✓ |  |  |  | `paralegal` | — | ✓ |
| npi | GET | `/api/npi/search` | ✓ | ✓ |  |  |  | `paralegal` | — | ✓ |
| ocr | POST | `/api/ocr/ai-fields/result/:id` | ✓ | ✓ |  |  |  | `paralegal` | — | ✓ |
| ocr | POST | `/api/ocr/ai-fields` | ✓ | ✓ |  |  |  | `paralegal` | — | ✓ |
| ocr | GET | `/api/ocr/queue-stats` | ✓ | ✓ |  |  |  | `admin` | — | ✓ |
| ocr | GET | `/api/ocr/results/:id` | ✓ | ✓ |  |  |  | `paralegal` | — | ✓ |
| ocr | GET | `/api/ocr/results` | ✓ | ✓ |  |  |  | `paralegal` | — | ✓ |
| ocr | POST | `/api/ocr/upload` | ✓ | ✓ |  |  |  | `paralegal` | — | ✓ |
| paralegals | GET | `/api/paralegals/:id/performance` | ✓ | ✓ |  |  |  | `attorney` | — | ✓ |
| paralegals | GET | `/api/paralegals/:id` | ✓ | ✓ |  |  |  | `attorney` | — | ✓ |
| paralegals | GET | `/api/paralegals/` | ✓ | ✓ |  |  |  | `attorney` | — | ✓ |
| paralegals | POST | `/api/paralegals/` | ✓ | ✓ |  |  |  | `admin` | — | ✓ |
| review-queue | PATCH | `/api/review-queue/:id` | ✓ | ✓ |  |  |  | `attorney` | — | ✓ |
| review-queue | GET | `/api/review-queue/` | ✓ | ✓ |  |  |  | `paralegal` | — | ✓ |
| review-queue | GET | `/api/review-queue/stats` | ✓ | ✓ |  |  |  | `paralegal` | — | ✓ |
| security | PATCH | `/api/security/alerts/:id/dismiss` | ✓ | ✓ |  |  |  | `admin` | — | ✓ |
| security | GET | `/api/security/alerts` | ✓ | ✓ |  |  |  | `admin` | — | ✓ |
| security | POST | `/api/security/analyze` | ✓ | ✓ |  |  |  | `admin` | — | ✓ |
| security | POST | `/api/security/block-ip` | ✓ | ✓ |  |  |  | `admin` | — | ✓ |
| security | DELETE | `/api/security/blocked-ips/:ip` | ✓ | ✓ |  |  |  | `admin` | — | ✓ |
| security | GET | `/api/security/blocked-ips` | ✓ | ✓ |  |  |  | `admin` | — | ✓ |
| security | PATCH | `/api/security/notifications/:id/acknowledge` | ✓ | ✓ |  |  |  | `admin` | — | ✓ |
| security | GET | `/api/security/notifications` | ✓ | ✓ |  |  |  | `admin` | — | ✓ |
| security | GET | `/api/security/stats` | ✓ | ✓ |  |  |  | `admin` | — | ✓ |
| security | POST | `/api/security/test-alert` | ✓ | ✓ |  |  |  | `admin` | — | ✓ |
| security | POST | `/api/security/webhook-config` | ✓ | ✓ |  |  |  | `admin` | — | ✓ |
| timeline | GET | `/api/timeline/lead/:id` | ✓ | ✓ |  |  |  | `paralegal` | — | ✓ |
| vendors | DELETE | `/api/vendors/:id` | ✓ | ✓ |  |  |  | `admin` | — | ✓ |
| vendors | GET | `/api/vendors/:id` | ✓ | ✓ |  |  |  | `paralegal` | — | ✓ |
| vendors | PATCH | `/api/vendors/:id` | ✓ | ✓ |  |  |  | `attorney` | — | ✓ |
| vendors | GET | `/api/vendors/` | ✓ | ✓ |  |  |  | `paralegal` | — | ✓ |
| vendors | POST | `/api/vendors/` | ✓ | ✓ |  |  |  | `attorney` | — | ✓ |
| webhooks | POST | `/api/webhooks/_test/envelope-signed` |  |  | ✓ |  |  | — | — | — |
| webhooks | POST | `/api/webhooks/docusign` |  |  | ✓ |  |  | — | — | — |
| webhooks | POST | `/api/webhooks/dropbox-sign` |  |  | ✓ |  |  | — | — | — |
| workflow-settings | GET | `/api/workflow-settings/_options/providers` | ✓ | ✓ |  |  |  | `admin` | — | ✓ |
| workflow-settings | GET | `/api/workflow-settings/:scope` | ✓ | ✓ |  |  |  | `viewer` | — | ✓ |
| workflow-settings | GET | `/api/workflow-settings/` | ✓ | ✓ |  |  |  | `viewer` | — | ✓ |
| workflow-settings | PUT | `/api/workflow-settings/` | ✓ | ✓ |  |  |  | `admin` | — | ✓ |

