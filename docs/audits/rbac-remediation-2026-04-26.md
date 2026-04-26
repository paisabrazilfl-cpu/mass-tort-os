# RBAC Remediation Audit — 2026-04-26

**Scope:** `artifacts/api-server`
**Outcome:** Production-grade RBAC. Single source of truth, deny-by-default routing
enforced at boot, normalised 401/403 envelope, audit trail on every denial,
zero "user.id !== 0" god-mode branches remain in code paths.
**Boot-time validator result:** 157 routes checked, 10 public, 147 protected,
**0 unprotected**.
**Test result:** `src/lib/__tests__/rbac.test.ts` — 47 / 47 passing
(39 RBAC matrix tests + 6 boot-time route table validator regression tests
[including two explicit forge-attempt tests] + 2 dev-mode predicate tests
covering production / staging / casing / whitespace bypass prevention).

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
| `requirePermission(perm)` | Permission-gated middleware (preferred for new handlers). |
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

- Added `created_by_user_id` integer column to `cases` schema (db push completed).
- `worker.ts` now plumbs `created_by_user_id` through the `create_case`
  payload so background-job-created cases attribute the original requester.
- `GET /` filters by `created_by_user_id` for non-bypass roles.
- `GET /:id` calls `denyForbidden(... "case_ownership_denied" ...)` when a
  non-bypass role requests a case they don't own — both the canonical
  envelope and an audit-log row are emitted.
- **Note on owner-or-assigned semantics:** the `cases` table only carries
  `created_by_user_id`; there is no `assigned_to` column equivalent to
  `leads.assigned_to`. The viewer ownership check is therefore strict
  owner-only by schema. Adding case assignment is tracked separately as
  follow-up work (Task #11 candidate); when that column lands, the filter
  on `GET /` and the predicate in `GET /:id` should be widened to
  `created_by_user_id === user.id || assigned_to === user.id` to match
  the leads convention.

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

### Audited ownership denials

The original implementation only wrote audit entries from the rbac middleware
(401/403 from `requireRole`, `requirePermission`, `authMiddleware`). Per-route
ownership rejections (e.g. "you have the right role, but you don't own this
case") still emitted a 403 but skipped the audit log — invisible in an SOC
review.

`lib/rbac.ts` now exports `denyForbidden(req, res, reason, message?, extra?)`
which writes an `audit_log` row with the per-route reason and ownership
metadata before sending the canonical envelope.

| Site | Reason | Metadata |
| --- | --- | --- |
| `cases.ts` GET `/:id` | `case_ownership_denied` | `case_id`, `owner_user_id` |
| `leads.ts` GET `/:id` | `lead_ownership_denied` | `lead_id`, `owner_user_id`, `assigned_to` |
| `leads.ts` `ensureLeadAccess` (envelopes/fax-results) | `lead_ownership_denied` | `lead_id`, `owner_user_id`, `assigned_to` |
| `leads.ts` PATCH `/:id` | `lead_ownership_denied` | `lead_id`, `owner_user_id`, `assigned_to` |
| `leads.ts` qualify path | `lead_ownership_denied` | `lead_id`, `owner_user_id`, `assigned_to` |
| `leads.ts` notes endpoint | `lead_ownership_denied` | `lead_id`, `owner_user_id`, `assigned_to` |

Audit log writes are best-effort and never throw into the denial path;
`RBAC_DISABLE_AUDIT=1` disables them in unit tests so test runs do not
require a database connection.

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

---

## 7. Tests — `src/lib/__tests__/rbac.test.ts`

47 / 47 passing under `node:test`. Coverage matrix:

| Group | Cases |
| --- | --- |
| `ROLE_PERMISSIONS` consistency | every role has a defined entry; lower roles are a strict subset of higher ones |
| `hasPermission` | per-role allow/deny for every `Permission` |
| `canBypassOwnership` | admin / attorney true; paralegal / viewer false |
| `requireRole` hierarchy | every (required role × actual role) cell of the 4×4 matrix; multi-role lists; missing user → 401 |
| `requirePermission` | allow / deny / missing user → 401 |
| `authMiddleware` | no header → 401; malformed Bearer → 401; envelope shape `{status, code, message}` |
| Dev gate | `IS_DEV` reflects current `NODE_ENV`; **the predicate is FALSE for `production` / `staging` / `test` / unset**; **TRUE only for the literal string `"development"`** (rejects `Development`, `DEVELOPMENT`, `development ` (trailing space), ` development` (leading space), `dev`, `develop`) |
| **`validateRouteTable`** (boot-time) | rejects authenticated route with no gate; accepts authenticated + gated; **a contributor-named `requireRole` noop CANNOT bypass the validator**; `requirePermission` satisfies the gate; **a `Symbol.for()` router stamp CANNOT impersonate `markPublic`**; missing `authMiddleware` fails even with a gate present |

---

## 8. Boot-time route table check

```
[15:50:03.532] INFO: Route table validated
    checked: 157
    public: 10
    protected: 147
[15:50:03.535] INFO: MTOS API server listening
    port: 8080
    node_env: "development"
    dev_mode: true
    has_session_secret: true
    has_encryption_key: true
    has_database_url: true
```

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
lib/db/src/schema/cases.ts                        +6       created_by_user_id column
artifacts/api-server/src/lib/__tests__/rbac.test.ts (new)  39 unit tests
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
