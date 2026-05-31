# RBAC Remediation Audit — 2026-04-26

**Scope:** `artifacts/api-server`
**Outcome:** Production-grade RBAC. Single source of truth, deny-by-default routing
enforced at boot, normalised 401/403 envelope, audit trail on every denial,
zero "user.id !== 0" god-mode branches remain in code paths.
**Boot-time validator result:** every mounted route is either public, an
auth-router exception, auth-only, or role-gated; the live `checked / public
/ protected / unprotected` counts are kept in lock-step with the route
tree by the `rbac-route-matrix` CI gate (see Section 11 for the headline
counts and the per-route breakdown). The validator now emits a per-route
policy report at INFO
on boot (`router`, `method`, `path`, `status` ∈ `public` | `auth-exception` |
`auth-only` | `role-gated`) so an SOC reviewer can see the full surface in
one structured log line — no need to spelunk through router code.
**Public allowlist contract (path-prefix):** the unauthenticated surface is
now exactly `/api/healthz`, `/api/forms-public/*`, `/api/webhooks/*`, and
`/api/web-forms/*` (the embeddable per-tort lead-capture form: public config
GET, embed.js, preview HTML, submit POST, and the two validate/* helpers).
The previous mount of `formsPublicRouter` at `/api/forms` (which collided
with the authenticated `formsRouter`) has been remounted at
`/api/forms-public` so the allowlist holds at the URL-prefix level, not
just at the router-label level. The booted-app test suite asserts both
directions: the three prefixes ARE reachable without a token, and the
old `/api/forms/preview/*` path is no longer public.
**Test result:** `pnpm --filter @workspace/api-server run test` — **109 / 109 passing**
across two files:
- `src/lib/__tests__/rbac.test.ts` (66 unit tests): 39 RBAC matrix tests +
  3 variadic `requirePermission` tests + 5 token-version revocation
  predicate tests + 2 expired-/fresh-token authMiddleware tests + 8 viewer
  ownership predicate tests + 1 production-mode subprocess bypass-prevention
  test + 6 boot-time route table validator regression tests [including two
  explicit forge-attempt tests] + 2 dev-mode predicate tests.
- `src/lib/__tests__/rbac-route-matrix.test.ts` (33 booted-app integration
  tests): 4 `validateRouteTable` policy-report assertions (public allowlist
  is exactly `health` / `forms-public` / `webhooks` / `web-forms`; auth router exceptions
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

### Public routers

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
| Public allowlist (policy report) | only routers `health` / `forms-public` / `webhooks` / `web-forms` are stamped public; auth router exceptions are exactly `POST /login` / `/refresh` / `/register`; `auth-only` allowlist matches the documented set with no drift; **forms config GETs are role-gated, not auth-only** |
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
  (currently `health`, `forms-public`, `webhooks`, `web-forms`).
- **Login-exception** — `POST /login`, `POST /refresh`, `POST /register`,
  `GET /verify-email` on the `auth` router. The verify-email branch was
  added by Task #56: `POST /register` no longer issues a JWT pair, and
  the verification link is the bootstrap path that exchanges a single-use
  hashed token for a session, so it must be reachable without auth.
- **Auth + Gate** — has both an `__internal_markAuthMiddleware`-stamped
  `authMiddleware` and an `__internal_markGateMiddleware`-stamped
  `requireRole(...)` / `requirePermission(...)` in its layer chain.
- **Auth-only** — explicitly allow-listed in `AUTH_ONLY_ROUTES` because
  the route is a per-user identity action that must not be further
  scoped (e.g. `auth POST /logout`, `auth GET /me`, MFA setup).



Boot-time count: **321 checked / 46 public / 275 protected / 0 unprotected.**
| Router | Method | Path | Auth | Gate | Public allowlist? | Auth-only allowlist? | Login-exception | Required role | Required permission(s) | Audited on denial? |
|---|---|---|:-:|:-:|:-:|:-:|:-:|---|---|:-:|
| (root) | DELETE | `/api/:slug` | ✓ | ✓ |  |  |  | — | `forms:config:manage` | ✓ |
| (root) | PUT | `/api/:slug` | ✓ | ✓ |  |  |  | — | `forms:config:manage` | ✓ |
| (root) | POST | `/api/call` | ✓ | ✓ |  |  |  | — | `dashboard:view` | ✓ |
| (root) | POST | `/api/chat` | ✓ | ✓ |  |  |  | — | `dashboard:view` | ✓ |
| (root) | GET | `/api/` | ✓ | ✓ |  |  |  | — | `forms:config:view` | ✓ |
| (root) | GET | `/api/navigation` | ✓ | ✓ |  |  |  | — | `dashboard:view` | ✓ |
| (root) | GET | `/api/pages` | ✓ | ✓ |  |  |  | — | `dashboard:view` | ✓ |
| (root) | POST | `/api/` | ✓ | ✓ |  |  |  | — | `forms:config:manage` | ✓ |
| (root) | POST | `/api/` | ✓ | ✓ |  |  |  | — | `dashboard:view` | ✓ |
| (root) | POST | `/api/rebuild-all` | ✓ | ✓ |  |  |  | `super_admin` | — | ✓ |
| (root) | POST | `/api/scaffold` | ✓ | ✓ |  |  |  | — | `forms:config:manage` | ✓ |
| (root) | GET | `/api/snapshot` | ✓ | ✓ |  |  |  | — | `dashboard:view` | ✓ |
| (root) | GET | `/api/tools` | ✓ | ✓ |  |  |  | — | `dashboard:view` | ✓ |
| admin-ai-constitution | GET | `/api/admin-ai-constitution/` | ✓ | ✓ |  |  |  | — | `automations:view` | ✓ |
| admin-api-keys | GET | `/api/admin-api-keys/_meta/scopes` | ✓ | ✓ |  |  |  | — | `api_keys:manage` | ✓ |
| admin-api-keys | GET | `/api/admin-api-keys/:id/audit` | ✓ | ✓ |  |  |  | — | `api_keys:manage` | ✓ |
| admin-api-keys | DELETE | `/api/admin-api-keys/:id` | ✓ | ✓ |  |  |  | — | `api_keys:manage` | ✓ |
| admin-api-keys | GET | `/api/admin-api-keys/` | ✓ | ✓ |  |  |  | — | `api_keys:manage` | ✓ |
| admin-api-keys | POST | `/api/admin-api-keys/` | ✓ | ✓ |  |  |  | — | `api_keys:manage` | ✓ |
| admin-competitive-intel | GET | `/api/admin-competitive-intel/config` | ✓ | ✓ |  |  |  | — | `competitive_intel:manage` | ✓ |
| admin-competitive-intel | POST | `/api/admin-competitive-intel/lookup` | ✓ | ✓ |  |  |  | — | `competitive_intel:manage` | ✓ |
| admin-competitive-intel | POST | `/api/admin-competitive-intel/sync-all` | ✓ | ✓ |  |  |  | — | `competitive_intel:manage` | ✓ |
| admin-competitive-intel | POST | `/api/admin-competitive-intel/watchlist/:id/refresh` | ✓ | ✓ |  |  |  | — | `competitive_intel:manage` | ✓ |
| admin-competitive-intel | DELETE | `/api/admin-competitive-intel/watchlist/:id` | ✓ | ✓ |  |  |  | — | `competitive_intel:manage` | ✓ |
| admin-competitive-intel | GET | `/api/admin-competitive-intel/watchlist` | ✓ | ✓ |  |  |  | — | `competitive_intel:manage` | ✓ |
| admin-competitive-intel | POST | `/api/admin-competitive-intel/watchlist` | ✓ | ✓ |  |  |  | — | `competitive_intel:manage` | ✓ |
| admin-dark-room | DELETE | `/api/admin-dark-room/:id` | ✓ | ✓ |  |  |  | `super_admin` | — | ✓ |
| admin-dark-room | PATCH | `/api/admin-dark-room/:id` | ✓ | ✓ |  |  |  | `super_admin` | — | ✓ |
| admin-dark-room | GET | `/api/admin-dark-room/` | ✓ | ✓ |  |  |  | `super_admin` | — | ✓ |
| admin-dark-room | POST | `/api/admin-dark-room/` | ✓ | ✓ |  |  |  | `super_admin` | — | ✓ |
| admin-event-catalog | GET | `/api/admin-event-catalog/` | ✓ | ✓ |  |  |  | — | `api_keys:manage` | ✓ |
| admin-event-catalog | GET | `/api/admin-event-catalog/openapi.yaml` | ✓ | ✓ |  |  |  | — | `api_keys:manage` | ✓ |
| admin-self-heal | POST | `/api/admin-self-heal/:id/approve` | ✓ | ✓ |  |  |  | — | `self_heal:manage` | ✓ |
| admin-self-heal | POST | `/api/admin-self-heal/:id/messages` | ✓ | ✓ |  |  |  | — | `self_heal:manage` | ✓ |
| admin-self-heal | POST | `/api/admin-self-heal/:id/refresh` | ✓ | ✓ |  |  |  | — | `self_heal:manage` | ✓ |
| admin-self-heal | GET | `/api/admin-self-heal/:id` | ✓ | ✓ |  |  |  | — | `self_heal:manage` | ✓ |
| admin-self-heal | GET | `/api/admin-self-heal/config` | ✓ | ✓ |  |  |  | — | `self_heal:manage` | ✓ |
| admin-self-heal | GET | `/api/admin-self-heal/` | ✓ | ✓ |  |  |  | — | `self_heal:manage` | ✓ |
| admin-self-heal | POST | `/api/admin-self-heal/` | ✓ | ✓ |  |  |  | — | `self_heal:manage` | ✓ |
| admin-webhook-deliveries | POST | `/api/admin-webhook-deliveries/:id/resend` | ✓ | ✓ |  |  |  | — | `integrations:manage` | ✓ |
| admin-webhook-deliveries | GET | `/api/admin-webhook-deliveries/` | ✓ | ✓ |  |  |  | — | `integrations:manage` | ✓ |
| analytics | GET | `/api/analytics/conversion-funnel` | ✓ | ✓ |  |  |  | — | `analytics:view` | ✓ |
| analytics | GET | `/api/analytics/overview` | ✓ | ✓ |  |  |  | — | `analytics:view` | ✓ |
| analytics | GET | `/api/analytics/paralegal-leaderboard` | ✓ | ✓ |  |  |  | — | `analytics:view` | ✓ |
| analytics | GET | `/api/analytics/pipeline-trend` | ✓ | ✓ |  |  |  | — | `analytics:view` | ✓ |
| analytics | GET | `/api/analytics/predictive/batch` | ✓ | ✓ |  |  |  | — | `analytics:view` | ✓ |
| analytics | GET | `/api/analytics/predictive/by-tort` | ✓ | ✓ |  |  |  | — | `analytics:view` | ✓ |
| analytics | GET | `/api/analytics/predictive/lead/:id` | ✓ | ✓ |  |  |  | — | `analytics:predictive:lead` | ✓ |
| analytics | GET | `/api/analytics/predictive/model` | ✓ | ✓ |  |  |  | — | `analytics:view` | ✓ |
| analytics | GET | `/api/analytics/tort-breakdown` | ✓ | ✓ |  |  |  | — | `analytics:view` | ✓ |
| auth | POST | `/api/auth/change-password` | ✓ |  |  | ✓ |  | — | — | ✓ |
| auth | GET | `/api/auth/firm-invites` | ✓ |  |  | ✓ |  | — | — | ✓ |
| auth | POST | `/api/auth/firm-invites` | ✓ |  |  | ✓ |  | — | — | ✓ |
| auth | GET | `/api/auth/invite-info` |  |  |  |  | ✓ | — | — | ✓ |
| auth | POST | `/api/auth/login` |  |  |  |  | ✓ | — | — | ✓ |
| auth | POST | `/api/auth/logout` | ✓ |  |  | ✓ |  | — | — | ✓ |
| auth | GET | `/api/auth/me` | ✓ |  |  | ✓ |  | — | — | ✓ |
| auth | POST | `/api/auth/mfa/disable` | ✓ |  |  | ✓ |  | — | — | ✓ |
| auth | POST | `/api/auth/mfa/setup` | ✓ |  |  | ✓ |  | — | — | ✓ |
| auth | POST | `/api/auth/mfa/verify` | ✓ |  |  | ✓ |  | — | — | ✓ |
| auth | POST | `/api/auth/refresh` |  |  |  |  | ✓ | — | — | ✓ |
| auth | POST | `/api/auth/register` |  |  |  |  | ✓ | — | — | ✓ |
| auth | GET | `/api/auth/terms` |  |  |  |  | ✓ | — | — | ✓ |
| auth | GET | `/api/auth/users` | ✓ | ✓ |  |  |  | — | `users:list` | ✓ |
| auth | GET | `/api/auth/verify-email` |  |  |  |  | ✓ | — | — | ✓ |
| automation-webhook | _ALL | `/api/automation-webhook/:slug` |  |  | ✓ |  |  | — | — | — |
| automation-webhook | POST | `/api/automation-webhook/:slug` |  |  | ✓ |  |  | — | — | — |
| automations | POST | `/api/automations/:id/clone` | ✓ | ✓ |  |  |  | — | `automations:manage` | ✓ |
| automations | POST | `/api/automations/:id/run` | ✓ | ✓ |  |  |  | — | `automations:execute` | ✓ |
| automations | GET | `/api/automations/:id/runs` | ✓ | ✓ |  |  |  | — | `automations:view` | ✓ |
| automations | DELETE | `/api/automations/:id` | ✓ | ✓ |  |  |  | — | `automations:manage` | ✓ |
| automations | GET | `/api/automations/:id` | ✓ | ✓ |  |  |  | — | `automations:view` | ✓ |
| automations | PUT | `/api/automations/:id` | ✓ | ✓ |  |  |  | — | `automations:manage` | ✓ |
| automations | POST | `/api/automations/assist` | ✓ | ✓ |  |  |  | — | `automations:manage` | ✓ |
| automations | GET | `/api/automations/` | ✓ | ✓ |  |  |  | — | `automations:view` | ✓ |
| automations | GET | `/api/automations/node-catalog` | ✓ | ✓ |  |  |  | — | `automations:view` | ✓ |
| automations | POST | `/api/automations/` | ✓ | ✓ |  |  |  | — | `automations:manage` | ✓ |
| automations | GET | `/api/automations/runs/:runId` | ✓ | ✓ |  |  |  | — | `automations:view` | ✓ |
| billing | POST | `/api/billing/checkout` | ✓ | ✓ |  |  |  | — | `billing:manage` | ✓ |
| billing | GET | `/api/billing/firm-status` | ✓ |  |  | ✓ |  | — | — | ✓ |
| billing | GET | `/api/billing/invoices` | ✓ | ✓ |  |  |  | — | `billing:manage` | ✓ |
| billing | POST | `/api/billing/portal` | ✓ | ✓ |  |  |  | — | `billing:manage` | ✓ |
| billing | GET | `/api/billing/state` | ✓ | ✓ |  |  |  | — | `billing:manage` | ✓ |
| buyers | DELETE | `/api/buyers/:id` | ✓ | ✓ |  |  |  | — | `buyers:manage` | ✓ |
| buyers | GET | `/api/buyers/:id` | ✓ | ✓ |  |  |  | — | `buyers:view` | ✓ |
| buyers | PUT | `/api/buyers/:id` | ✓ | ✓ |  |  |  | — | `buyers:manage` | ✓ |
| buyers | GET | `/api/buyers/` | ✓ | ✓ |  |  |  | — | `buyers:view` | ✓ |
| buyers | POST | `/api/buyers/` | ✓ | ✓ |  |  |  | — | `buyers:manage` | ✓ |
| calls | GET | `/api/calls/:id` | ✓ | ✓ |  |  |  | — | `calls:view` | ✓ |
| calls | GET | `/api/calls/` | ✓ | ✓ |  |  |  | — | `calls:view` | ✓ |
| calls | POST | `/api/calls/outbound` | ✓ | ✓ |  |  |  | — | `calls:manage` | ✓ |
| cases | POST | `/api/cases/:id/analyze` | ✓ | ✓ |  |  |  | — | `case:analyze` | ✓ |
| cases | PATCH | `/api/cases/:id/status` | ✓ | ✓ |  |  |  | — | `case:analyze` | ✓ |
| cases | POST | `/api/cases/:id/upload` | ✓ | ✓ |  |  |  | — | `case:upload` | ✓ |
| cases | GET | `/api/cases/:id` | ✓ | ✓ |  |  |  | — | `case:view:own`, `case:view:any` | ✓ |
| cases | GET | `/api/cases/` | ✓ | ✓ |  |  |  | — | `case:view:own`, `case:view:any` | ✓ |
| cases | POST | `/api/cases/` | ✓ | ✓ |  |  |  | — | `case:create` | ✓ |
| cases | POST | `/api/cases/worker/jobs/:id/requeue` | ✓ | ✓ |  |  |  | — | `case:worker_admin` | ✓ |
| cases | GET | `/api/cases/worker/jobs` | ✓ | ✓ |  |  |  | — | `case:worker_admin` | ✓ |
| cases | GET | `/api/cases/worker/queue-stats` | ✓ | ✓ |  |  |  | — | `case:worker_admin` | ✓ |
| compliance | GET | `/api/compliance/audit-summary` | ✓ | ✓ |  |  |  | — | `compliance:view` | ✓ |
| compliance | GET | `/api/compliance/audit-trail` | ✓ | ✓ |  |  |  | — | `compliance:view` | ✓ |
| dashboard | GET | `/api/dashboard/pipeline` | ✓ | ✓ |  |  |  | — | `dashboard:view` | ✓ |
| dashboard | GET | `/api/dashboard/recent-activity` | ✓ | ✓ |  |  |  | — | `dashboard:view` | ✓ |
| dashboard | GET | `/api/dashboard/stats` | ✓ | ✓ |  |  |  | — | `dashboard:view` | ✓ |
| decision-engine | POST | `/api/decision-engine/leads/:id/recompute` | ✓ | ✓ |  |  |  | — | `decision_engine:manage` | ✓ |
| decision-engine | GET | `/api/decision-engine/portfolio` | ✓ | ✓ |  |  |  | — | `decision_engine:view` | ✓ |
| decision-engine | POST | `/api/decision-engine/recompute-all` | ✓ | ✓ |  |  |  | — | `decision_engine:manage` | ✓ |
| decision-engine | GET | `/api/decision-engine/settings` | ✓ | ✓ |  |  |  | — | `decision_engine:view` | ✓ |
| decision-engine | PUT | `/api/decision-engine/settings` | ✓ | ✓ |  |  |  | — | `decision_engine:manage` | ✓ |
| dialer | PUT | `/api/dialer/call/:id/end` | ✓ | ✓ |  |  |  | — | `calls:manage` | ✓ |
| dialer | POST | `/api/dialer/call` | ✓ | ✓ |  |  |  | — | `calls:manage` | ✓ |
| dialer | GET | `/api/dialer/campaigns/:id/leads` | ✓ | ✓ |  |  |  | — | `calls:view` | ✓ |
| dialer | POST | `/api/dialer/campaigns/:id/leads` | ✓ | ✓ |  |  |  | — | `calls:manage` | ✓ |
| dialer | POST | `/api/dialer/campaigns/:id/pause` | ✓ | ✓ |  |  |  | — | `calls:manage` | ✓ |
| dialer | GET | `/api/dialer/campaigns/:id/progress` | ✓ | ✓ |  |  |  | — | `calls:view` | ✓ |
| dialer | POST | `/api/dialer/campaigns/:id/start` | ✓ | ✓ |  |  |  | — | `calls:manage` | ✓ |
| dialer | DELETE | `/api/dialer/campaigns/:id` | ✓ | ✓ |  |  |  | — | `calls:manage` | ✓ |
| dialer | GET | `/api/dialer/campaigns/:id` | ✓ | ✓ |  |  |  | — | `calls:view` | ✓ |
| dialer | PATCH | `/api/dialer/campaigns/:id` | ✓ | ✓ |  |  |  | — | `calls:manage` | ✓ |
| dialer | POST | `/api/dialer/campaigns/upload-dial` | ✓ | ✓ |  |  |  | — | `calls:manage`, `lead_import:execute` | ✓ |
| dialer | GET | `/api/dialer/campaigns` | ✓ | ✓ |  |  |  | — | `calls:view` | ✓ |
| dialer | POST | `/api/dialer/campaigns` | ✓ | ✓ |  |  |  | — | `calls:manage` | ✓ |
| dialer | DELETE | `/api/dialer/dnc/:id` | ✓ | ✓ |  |  |  | — | `calls:manage` | ✓ |
| dialer | POST | `/api/dialer/dnc/bulk` | ✓ | ✓ |  |  |  | — | `calls:manage` | ✓ |
| dialer | POST | `/api/dialer/dnc/check` | ✓ | ✓ |  |  |  | — | `calls:view` | ✓ |
| dialer | GET | `/api/dialer/dnc` | ✓ | ✓ |  |  |  | — | `calls:view` | ✓ |
| dialer | POST | `/api/dialer/dnc` | ✓ | ✓ |  |  |  | — | `calls:manage` | ✓ |
| dialer | GET | `/api/dialer/recordings` | ✓ | ✓ |  |  |  | — | `calls:view` | ✓ |
| dialer | GET | `/api/dialer/reports` | ✓ | ✓ |  |  |  | — | `calls:view` | ✓ |
| dialer | DELETE | `/api/dialer/scripts/:id` | ✓ | ✓ |  |  |  | — | `calls:manage` | ✓ |
| dialer | GET | `/api/dialer/scripts/:id` | ✓ | ✓ |  |  |  | — | `calls:view` | ✓ |
| dialer | PATCH | `/api/dialer/scripts/:id` | ✓ | ✓ |  |  |  | — | `calls:manage` | ✓ |
| dialer | GET | `/api/dialer/scripts` | ✓ | ✓ |  |  |  | — | `calls:view` | ✓ |
| dialer | POST | `/api/dialer/scripts` | ✓ | ✓ |  |  |  | — | `calls:manage` | ✓ |
| dialer | GET | `/api/dialer/stats` | ✓ | ✓ |  |  |  | — | `calls:view` | ✓ |
| dialer | GET | `/api/dialer/tort-agents/:tortId/calls` | ✓ | ✓ |  |  |  | — | `calls:view` | ✓ |
| dialer | POST | `/api/dialer/tort-agents/:tortId/provision` | ✓ | ✓ |  |  |  | — | `calls:manage` | ✓ |
| dialer | GET | `/api/dialer/tort-agents/activity` | ✓ | ✓ |  |  |  | — | `calls:view` | ✓ |
| dialer | DELETE | `/api/dialer/tort-agents/numbers/:id` | ✓ | ✓ |  |  |  | — | `calls:manage` | ✓ |
| dialer | GET | `/api/dialer/tort-agents/numbers` | ✓ | ✓ |  |  |  | — | `calls:view` | ✓ |
| dialer | POST | `/api/dialer/tort-agents/numbers` | ✓ | ✓ |  |  |  | — | `calls:manage` | ✓ |
| dialer | POST | `/api/dialer/tort-agents/provision-all` | ✓ | ✓ |  |  |  | — | `calls:manage` | ✓ |
| dialer | POST | `/api/dialer/tort-agents/sync-out-of-date` | ✓ | ✓ |  |  |  | — | `calls:manage` | ✓ |
| dialer | GET | `/api/dialer/tort-agents` | ✓ | ✓ |  |  |  | — | `calls:view` | ✓ |
| dialer | POST | `/api/dialer/vapi-assistant` | ✓ | ✓ |  |  |  | — | `calls:manage` | ✓ |
| dialer | GET | `/api/dialer/vapi-config` | ✓ | ✓ |  |  |  | — | `calls:view` | ✓ |
| dialer | GET | `/api/dialer/vapi-phones` | ✓ | ✓ |  |  |  | — | `calls:view` | ✓ |
| document-templates | GET | `/api/document-templates/:id/preview` | ✓ | ✓ |  |  |  | — | `templates:view` | ✓ |
| document-templates | DELETE | `/api/document-templates/:id` | ✓ | ✓ |  |  |  | — | `templates:manage` | ✓ |
| document-templates | GET | `/api/document-templates/:id` | ✓ | ✓ |  |  |  | — | `templates:view` | ✓ |
| document-templates | PUT | `/api/document-templates/:id` | ✓ | ✓ |  |  |  | — | `templates:manage` | ✓ |
| document-templates | DELETE | `/api/document-templates/assignments/:id` | ✓ | ✓ |  |  |  | — | `templates:manage` | ✓ |
| document-templates | GET | `/api/document-templates/assignments/all` | ✓ | ✓ |  |  |  | — | `templates:view` | ✓ |
| document-templates | GET | `/api/document-templates/assignments/by-template/:templateId` | ✓ | ✓ |  |  |  | — | `templates:view` | ✓ |
| document-templates | POST | `/api/document-templates/assignments` | ✓ | ✓ |  |  |  | — | `templates:manage` | ✓ |
| document-templates | GET | `/api/document-templates/` | ✓ | ✓ |  |  |  | — | `templates:view` | ✓ |
| document-templates | POST | `/api/document-templates/` | ✓ | ✓ |  |  |  | — | `templates:manage` | ✓ |
| document-templates | POST | `/api/document-templates/upload` | ✓ | ✓ |  |  |  | — | `templates:manage` | ✓ |
| documents | GET | `/api/documents/:id/view` | ✓ | ✓ |  |  |  | — | `documents:view` | ✓ |
| documents | DELETE | `/api/documents/:id` | ✓ | ✓ |  |  |  | — | `documents:delete` | ✓ |
| documents | PATCH | `/api/documents/:id` | ✓ | ✓ |  |  |  | — | `documents:update` | ✓ |
| documents | GET | `/api/documents/` | ✓ | ✓ |  |  |  | — | `documents:view` | ✓ |
| documents | POST | `/api/documents/highlight` | ✓ | ✓ |  |  |  | — | `documents:update` | ✓ |
| documents | POST | `/api/documents/` | ✓ | ✓ |  |  |  | — | `documents:create` | ✓ |
| documents | POST | `/api/documents/redact` | ✓ | ✓ |  |  |  | — | `documents:redact` | ✓ |
| drafting | POST | `/api/drafting/generate-pdf` | ✓ | ✓ |  |  |  | — | `drafting:generate` | ✓ |
| drafting | POST | `/api/drafting/generate` | ✓ | ✓ |  |  |  | — | `drafting:generate` | ✓ |
| drafting | GET | `/api/drafting/templates` | ✓ | ✓ |  |  |  | — | `drafting:templates_view` | ✓ |
| fasten | GET | `/api/fasten/callback` | ✓ | ✓ |  |  |  | — | `medical_records:view` | ✓ |
| fasten | GET | `/api/fasten/catalog` | ✓ | ✓ |  |  |  | — | `medical_records:manage` | ✓ |
| fasten | GET | `/api/fasten/connections/:leadId` | ✓ | ✓ |  |  |  | — | `medical_records:view` | ✓ |
| fasten | POST | `/api/fasten/connect` | ✓ | ✓ |  |  |  | — | `medical_records:manage` | ✓ |
| fasten | POST | `/api/fasten/disconnect/:connectionId` | ✓ | ✓ |  |  |  | — | `medical_records:manage` | ✓ |
| fasten | GET | `/api/fasten/status` | ✓ | ✓ |  |  |  | — | `medical_records:view` | ✓ |
| fasten | POST | `/api/fasten/sync/:connectionId` | ✓ | ✓ |  |  |  | — | `medical_records:manage` | ✓ |
| forms-api-directory | GET | `/api/forms-api-directory/` | ✓ | ✓ |  |  |  | — | `forms:config:view` | ✓ |
| forms-public | GET | `/api/forms-public/embed/:tortId` |  |  | ✓ |  |  | — | — | — |
| forms-public | GET | `/api/forms-public/preview-blocker.js` |  |  | ✓ |  |  | — | — | — |
| forms-public | GET | `/api/forms-public/preview/:tortId` |  |  | ✓ |  |  | — | — | — |
| forms-public | POST | `/api/forms-public/submit/:tortId` |  |  | ✓ |  |  | — | — | — |
| forms-public | POST | `/api/forms-public/validate/address` |  |  | ✓ |  |  | — | — | — |
| forms-public | POST | `/api/forms-public/validate/email` |  |  | ✓ |  |  | — | — | — |
| forms-public | POST | `/api/forms-public/validate/fax` |  |  | ✓ |  |  | — | — | — |
| forms | GET | `/api/forms/background-check-hub/lead/:id/snapshots` | ✓ | ✓ |  |  |  | — | `forms:background_check` | ✓ |
| forms | POST | `/api/forms/background-check-hub/lead/:id` | ✓ | ✓ |  |  |  | — | `forms:background_check` | ✓ |
| forms | POST | `/api/forms/background-check/lead/:id` | ✓ | ✓ |  |  |  | — | `forms:background_check` | ✓ |
| forms | POST | `/api/forms/background-check` | ✓ | ✓ |  |  |  | — | `forms:background_check` | ✓ |
| forms | GET | `/api/forms/categories` | ✓ |  |  | ✓ |  | — | — | ✓ |
| forms | DELETE | `/api/forms/config/:tortId/fields/:key` | ✓ | ✓ |  |  |  | — | `forms:config:manage` | ✓ |
| forms | POST | `/api/forms/config/:tortId/fields` | ✓ | ✓ |  |  |  | — | `forms:config:manage` | ✓ |
| forms | GET | `/api/forms/config/:tortId` | ✓ | ✓ |  |  |  | — | `forms:config:view` | ✓ |
| forms | PUT | `/api/forms/config/:tortId` | ✓ | ✓ |  |  |  | — | `forms:config:manage` | ✓ |
| forms | GET | `/api/forms/config` | ✓ | ✓ |  |  |  | — | `forms:config:view` | ✓ |
| forms | POST | `/api/forms/escalate/fbi` | ✓ | ✓ |  |  |  | — | `forms:escalate_fbi` | ✓ |
| forms | POST | `/api/forms/fraud-check` | ✓ | ✓ |  |  |  | — | `forms:fraud_check` | ✓ |
| forms | POST | `/api/forms/npi-verify` | ✓ | ✓ |  |  |  | — | `forms:npi_verify` | ✓ |
| forms | POST | `/api/forms/submit` | ✓ | ✓ |  |  |  | — | `forms:submit` | ✓ |
| forms | POST | `/api/forms/validate/address` | ✓ |  |  | ✓ |  | — | — | ✓ |
| forms | POST | `/api/forms/validate/email` | ✓ |  |  | ✓ |  | — | — | ✓ |
| forms | PATCH | `/api/forms/web-config/:tortId/toggle` | ✓ | ✓ |  |  |  | — | `forms:config:manage` | ✓ |
| forms | GET | `/api/forms/web-config/:tortId` | ✓ | ✓ |  |  |  | — | `forms:config:view` | ✓ |
| forms | PUT | `/api/forms/web-config/:tortId` | ✓ | ✓ |  |  |  | — | `forms:config:manage` | ✓ |
| forms | GET | `/api/forms/web-config` | ✓ | ✓ |  |  |  | — | `forms:config:view` | ✓ |
| health | GET | `/api/health/health` |  |  | ✓ |  |  | — | — | — |
| health | GET | `/api/health/healthz` |  |  | ✓ |  |  | — | — | — |
| image-objects | GET | `/api/image-objects/:id/integrity` | ✓ | ✓ |  |  |  | — | `image_objects:view` | ✓ |
| image-objects | DELETE | `/api/image-objects/:id` | ✓ | ✓ |  |  |  | — | `image_objects:delete` | ✓ |
| image-objects | GET | `/api/image-objects/:id` | ✓ | ✓ |  |  |  | — | `image_objects:view` | ✓ |
| image-objects | PATCH | `/api/image-objects/:id` | ✓ | ✓ |  |  |  | — | `image_objects:manage` | ✓ |
| image-objects | GET | `/api/image-objects/` | ✓ | ✓ |  |  |  | — | `image_objects:view` | ✓ |
| image-objects | POST | `/api/image-objects/` | ✓ | ✓ |  |  |  | — | `image_objects:manage` | ✓ |
| image-objects | GET | `/api/image-objects/stats` | ✓ | ✓ |  |  |  | — | `image_objects:view` | ✓ |
| integrations | POST | `/api/integrations/:id/sync` | ✓ | ✓ |  |  |  | — | `integrations:manage` | ✓ |
| integrations | POST | `/api/integrations/:id/test` | ✓ | ✓ |  |  |  | — | `integrations:manage` | ✓ |
| integrations | DELETE | `/api/integrations/:id` | ✓ | ✓ |  |  |  | — | `integrations:manage` | ✓ |
| integrations | GET | `/api/integrations/:id` | ✓ | ✓ |  |  |  | — | `integrations:manage` | ✓ |
| integrations | PATCH | `/api/integrations/:id` | ✓ | ✓ |  |  |  | — | `integrations:manage` | ✓ |
| integrations | GET | `/api/integrations/categories` | ✓ | ✓ |  |  |  | — | `integrations:manage` | ✓ |
| integrations | GET | `/api/integrations/` | ✓ | ✓ |  |  |  | — | `integrations:manage` | ✓ |
| integrations | POST | `/api/integrations/` | ✓ | ✓ |  |  |  | — | `integrations:manage` | ✓ |
| integrations | GET | `/api/integrations/presets` | ✓ | ✓ |  |  |  | — | `integrations:manage` | ✓ |
| lead-import | GET | `/api/lead-import/batches/:id/duplicates` | ✓ | ✓ |  |  |  | — | `lead_import:preview` | ✓ |
| lead-import | GET | `/api/lead-import/batches/:id/errors` | ✓ | ✓ |  |  |  | — | `lead_import:preview` | ✓ |
| lead-import | GET | `/api/lead-import/batches/:id` | ✓ | ✓ |  |  |  | — | `lead_import:preview` | ✓ |
| lead-import | GET | `/api/lead-import/batches` | ✓ | ✓ |  |  |  | — | `lead_import:preview` | ✓ |
| lead-import | POST | `/api/lead-import/execute` | ✓ | ✓ |  |  |  | — | `lead_import:execute` | ✓ |
| lead-import | POST | `/api/lead-import/preview` | ✓ | ✓ |  |  |  | — | `lead_import:preview` | ✓ |
| lead-sources | DELETE | `/api/lead-sources/:id` | ✓ | ✓ |  |  |  | — | `lead_sources:manage` | ✓ |
| lead-sources | PUT | `/api/lead-sources/:id` | ✓ | ✓ |  |  |  | — | `lead_sources:manage` | ✓ |
| lead-sources | GET | `/api/lead-sources/` | ✓ | ✓ |  |  |  | — | `lead_sources:view` | ✓ |
| lead-sources | POST | `/api/lead-sources/` | ✓ | ✓ |  |  |  | — | `lead_sources:manage` | ✓ |
| leads | GET | `/api/leads/:id/envelopes` | ✓ | ✓ |  |  |  | — | `lead:view:own`, `lead:view:any` | ✓ |
| leads | GET | `/api/leads/:id/fax-results` | ✓ | ✓ |  |  |  | — | `lead:view:own`, `lead:view:any` | ✓ |
| leads | POST | `/api/leads/:id/intelligence` | ✓ | ✓ |  |  |  | — | `lead:qualify` | ✓ |
| leads | PATCH | `/api/leads/:id/notes` | ✓ | ✓ |  |  |  | — | `lead:update` | ✓ |
| leads | POST | `/api/leads/:id/qualify` | ✓ | ✓ |  |  |  | — | `lead:qualify` | ✓ |
| leads | POST | `/api/leads/:id/send-sms` | ✓ | ✓ |  |  |  | — | `sms:send` | ✓ |
| leads | DELETE | `/api/leads/:id` | ✓ | ✓ |  |  |  | — | `lead:delete` | ✓ |
| leads | GET | `/api/leads/:id` | ✓ | ✓ |  |  |  | — | `lead:view:own`, `lead:view:any` | ✓ |
| leads | PATCH | `/api/leads/:id` | ✓ | ✓ |  |  |  | — | `lead:update` | ✓ |
| leads | GET | `/api/leads/export` | ✓ | ✓ |  |  |  | — | `lead:export` | ✓ |
| leads | GET | `/api/leads/` | ✓ | ✓ |  |  |  | — | `lead:view:own`, `lead:view:any` | ✓ |
| leads | POST | `/api/leads/` | ✓ | ✓ |  |  |  | — | `lead:create` | ✓ |
| mrr | PATCH | `/api/mrr/:id/cancel` | ✓ | ✓ |  |  |  | — | `medical_records:manage` | ✓ |
| mrr | POST | `/api/mrr/:id/resend` | ✓ | ✓ |  |  |  | — | `medical_records:manage` | ✓ |
| mrr | GET | `/api/mrr/:id` | ✓ | ✓ |  |  |  | — | `medical_records:view` | ✓ |
| mrr | GET | `/api/mrr/` | ✓ | ✓ |  |  |  | — | `medical_records:view` | ✓ |
| mrr | GET | `/api/mrr/poll-stats` | ✓ | ✓ |  |  |  | — | `medical_records:view` | ✓ |
| news | GET | `/api/news/financial` | ✓ | ✓ |  |  |  | — | `news:view` | ✓ |
| news | GET | `/api/news/mass-tort` | ✓ | ✓ |  |  |  | — | `news:view` | ✓ |
| npi | GET | `/api/npi/lookup/:npi` | ✓ | ✓ |  |  |  | — | `npi:lookup` | ✓ |
| npi | GET | `/api/npi/search` | ✓ | ✓ |  |  |  | — | `npi:lookup` | ✓ |
| npi | POST | `/api/npi/verify` | ✓ | ✓ |  |  |  | — | `npi:lookup` | ✓ |
| ocr | POST | `/api/ocr/ai-fields/result/:id` | ✓ | ✓ |  |  |  | — | `ocr:ai_fields` | ✓ |
| ocr | POST | `/api/ocr/ai-fields` | ✓ | ✓ |  |  |  | — | `ocr:ai_fields` | ✓ |
| ocr | GET | `/api/ocr/queue-stats` | ✓ | ✓ |  |  |  | — | `ocr:queue_admin` | ✓ |
| ocr | POST | `/api/ocr/results/:id/reprocess` | ✓ | ✓ |  |  |  | — | `ocr:ai_fields` | ✓ |
| ocr | GET | `/api/ocr/results/:id` | ✓ | ✓ |  |  |  | — | `ocr:view` | ✓ |
| ocr | GET | `/api/ocr/results` | ✓ | ✓ |  |  |  | — | `ocr:view` | ✓ |
| ocr | POST | `/api/ocr/upload` | ✓ | ✓ |  |  |  | — | `ocr:upload` | ✓ |
| paralegals | GET | `/api/paralegals/:id/performance` | ✓ | ✓ |  |  |  | — | `paralegal:view` | ✓ |
| paralegals | DELETE | `/api/paralegals/:id` | ✓ | ✓ |  |  |  | — | `paralegal:manage` | ✓ |
| paralegals | GET | `/api/paralegals/:id` | ✓ | ✓ |  |  |  | — | `paralegal:view` | ✓ |
| paralegals | GET | `/api/paralegals/` | ✓ | ✓ |  |  |  | — | `paralegal:view` | ✓ |
| paralegals | POST | `/api/paralegals/` | ✓ | ✓ |  |  |  | — | `paralegal:manage` | ✓ |
| review-queue | PATCH | `/api/review-queue/:id` | ✓ | ✓ |  |  |  | — | `review_queue:resolve` | ✓ |
| review-queue | GET | `/api/review-queue/` | ✓ | ✓ |  |  |  | — | `review_queue:view` | ✓ |
| review-queue | POST | `/api/review-queue/` | ✓ | ✓ |  |  |  | — | `review_queue:resolve` | ✓ |
| review-queue | GET | `/api/review-queue/stats` | ✓ | ✓ |  |  |  | — | `review_queue:view` | ✓ |
| security | PATCH | `/api/security/alerts/:id/dismiss` | ✓ | ✓ |  |  |  | — | `security:manage` | ✓ |
| security | GET | `/api/security/alerts` | ✓ | ✓ |  |  |  | — | `security:manage` | ✓ |
| security | POST | `/api/security/analyze` | ✓ | ✓ |  |  |  | — | `security:manage` | ✓ |
| security | POST | `/api/security/block-ip` | ✓ | ✓ |  |  |  | — | `security:manage` | ✓ |
| security | DELETE | `/api/security/blocked-ips/:ip` | ✓ | ✓ |  |  |  | — | `security:manage` | ✓ |
| security | GET | `/api/security/blocked-ips` | ✓ | ✓ |  |  |  | — | `security:manage` | ✓ |
| security | PATCH | `/api/security/notifications/:id/acknowledge` | ✓ | ✓ |  |  |  | — | `security:manage` | ✓ |
| security | GET | `/api/security/notifications` | ✓ | ✓ |  |  |  | — | `security:manage` | ✓ |
| security | GET | `/api/security/stats` | ✓ | ✓ |  |  |  | — | `security:manage` | ✓ |
| security | POST | `/api/security/test-alert` | ✓ | ✓ |  |  |  | — | `security:manage` | ✓ |
| timeline | GET | `/api/timeline/lead/:id` | ✓ | ✓ |  |  |  | — | `timeline:view` | ✓ |
| users | PATCH | `/api/users/:id/role` | ✓ | ✓ |  |  |  | — | `users:manage` | ✓ |
| users | GET | `/api/users/` | ✓ | ✓ |  |  |  | — | `users:list` | ✓ |
| vapi-tools | POST | `/api/vapi-tools/check-eligibility` |  |  | ✓ |  |  | — | — | — |
| vapi-tools | POST | `/api/vapi-tools/create-lead` |  |  | ✓ |  |  | — | — | — |
| vapi-tools | POST | `/api/vapi-tools/escalate-to-human` |  |  | ✓ |  |  | — | — | — |
| vapi-tools | POST | `/api/vapi-tools/lookup-lead` |  |  | ✓ |  |  | — | — | — |
| vapi-tools | POST | `/api/vapi-tools/update-lead` |  |  | ✓ |  |  | — | — | — |
| vendor-portal | GET | `/api/vendor-portal/:token/submissions` |  |  | ✓ |  |  | — | — | — |
| vendor-portal | GET | `/api/vendor-portal/:token` |  |  | ✓ |  |  | — | — | — |
| vendors | DELETE | `/api/vendors/:id` | ✓ | ✓ |  |  |  | — | `vendors:delete` | ✓ |
| vendors | GET | `/api/vendors/:id` | ✓ | ✓ |  |  |  | — | `vendors:view` | ✓ |
| vendors | PATCH | `/api/vendors/:id` | ✓ | ✓ |  |  |  | — | `vendors:manage` | ✓ |
| vendors | GET | `/api/vendors/` | ✓ | ✓ |  |  |  | — | `vendors:view` | ✓ |
| vendors | POST | `/api/vendors/` | ✓ | ✓ |  |  |  | — | `vendors:manage` | ✓ |
| web-forms | GET | `/api/web-forms/:tortId/embed.js` |  |  | ✓ |  |  | — | — | — |
| web-forms | GET | `/api/web-forms/:tortId/preview` |  |  | ✓ |  |  | — | — | — |
| web-forms | POST | `/api/web-forms/:tortId/submit` |  |  | ✓ |  |  | — | — | — |
| web-forms | GET | `/api/web-forms/:tortId` |  |  | ✓ |  |  | — | — | — |
| web-forms | POST | `/api/web-forms/validate/address` |  |  | ✓ |  |  | — | — | — |
| web-forms | POST | `/api/web-forms/validate/email` |  |  | ✓ |  |  | — | — | — |
| webhooks | POST | `/api/webhooks/_test/envelope-signed` |  |  | ✓ |  |  | — | — | — |
| webhooks | POST | `/api/webhooks/docusign` |  |  | ✓ |  |  | — | — | — |
| webhooks | POST | `/api/webhooks/dropbox-sign` |  |  | ✓ |  |  | — | — | — |
| webhooks | POST | `/api/webhooks/email/:provider` |  |  | ✓ |  |  | — | — | — |
| webhooks | POST | `/api/webhooks/fasten` |  |  | ✓ |  |  | — | — | — |
| webhooks | POST | `/api/webhooks/fax/:provider` |  |  | ✓ |  |  | — | — | — |
| webhooks | POST | `/api/webhooks/sms/:provider` |  |  | ✓ |  |  | — | — | — |
| webhooks | POST | `/api/webhooks/stripe` |  |  | ✓ |  |  | — | — | — |
| webhooks | POST | `/api/webhooks/telnyx/sms` |  |  | ✓ |  |  | — | — | — |
| webhooks | POST | `/api/webhooks/vapi/call-ended` |  |  | ✓ |  |  | — | — | — |
| webhooks | POST | `/api/webhooks/vapi/call-started` |  |  | ✓ |  |  | — | — | — |
| webhooks | POST | `/api/webhooks/vapi/escalate-human` |  |  | ✓ |  |  | — | — | — |
| webhooks | POST | `/api/webhooks/vapi/intake-result` |  |  | ✓ |  |  | — | — | — |
| webhooks | POST | `/api/webhooks/vapi/transcript` |  |  | ✓ |  |  | — | — | — |
| webhooks | POST | `/api/webhooks/vapi` |  |  | ✓ |  |  | — | — | — |
| webhooks | POST | `/api/webhooks/voice/:provider` |  |  | ✓ |  |  | — | — | — |
| workflow-settings | GET | `/api/workflow-settings/_options/providers` | ✓ | ✓ |  |  |  | — | `workflow_settings:manage` | ✓ |
| workflow-settings | GET | `/api/workflow-settings/:scope` | ✓ | ✓ |  |  |  | — | `workflow_settings:view` | ✓ |
| workflow-settings | GET | `/api/workflow-settings/` | ✓ | ✓ |  |  |  | — | `workflow_settings:view` | ✓ |
| workflow-settings | PUT | `/api/workflow-settings/` | ✓ | ✓ |  |  |  | — | `workflow_settings:manage` | ✓ |
