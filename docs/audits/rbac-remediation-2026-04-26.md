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
artifacts/api-server/src/routes/decision-engine.ts +12/-…   read/write split (attorney/admin)
artifacts/api-server/src/scripts/dump-route-matrix.ts (new) live route-matrix exporter
lib/db/src/schema/cases.ts                       +12       created_by_user_id + assigned_to
artifacts/api-server/src/lib/__tests__/rbac.test.ts (new)  47 unit tests
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

| Router | Method | Path | Auth | Gate | Public | Auth-only | Login-exception |
|---|---|---|:-:|:-:|:-:|:-:|:-:|
| analytics | GET | `/api/analytics/conversion-funnel` | ✓ | ✓ |  |  |  |
| analytics | GET | `/api/analytics/overview` | ✓ | ✓ |  |  |  |
| analytics | GET | `/api/analytics/paralegal-leaderboard` | ✓ | ✓ |  |  |  |
| analytics | GET | `/api/analytics/pipeline-trend` | ✓ | ✓ |  |  |  |
| analytics | GET | `/api/analytics/predictive/batch` | ✓ | ✓ |  |  |  |
| analytics | GET | `/api/analytics/predictive/by-tort` | ✓ | ✓ |  |  |  |
| analytics | GET | `/api/analytics/predictive/lead/:id` | ✓ | ✓ |  |  |  |
| analytics | GET | `/api/analytics/predictive/model` | ✓ | ✓ |  |  |  |
| analytics | GET | `/api/analytics/tort-breakdown` | ✓ | ✓ |  |  |  |
| auth | POST | `/api/auth/change-password` | ✓ |  |  | ✓ |  |
| auth | POST | `/api/auth/login` |  |  |  |  | ✓ |
| auth | POST | `/api/auth/logout` | ✓ |  |  | ✓ |  |
| auth | GET | `/api/auth/me` | ✓ |  |  | ✓ |  |
| auth | POST | `/api/auth/mfa/disable` | ✓ |  |  | ✓ |  |
| auth | POST | `/api/auth/mfa/setup` | ✓ |  |  | ✓ |  |
| auth | POST | `/api/auth/mfa/verify` | ✓ |  |  | ✓ |  |
| auth | POST | `/api/auth/refresh` |  |  |  |  | ✓ |
| auth | POST | `/api/auth/register` |  |  |  |  | ✓ |
| auth | GET | `/api/auth/users` | ✓ | ✓ |  |  |  |
| buyers | DELETE | `/api/buyers/:id` | ✓ | ✓ |  |  |  |
| buyers | GET | `/api/buyers/:id` | ✓ | ✓ |  |  |  |
| buyers | PUT | `/api/buyers/:id` | ✓ | ✓ |  |  |  |
| buyers | GET | `/api/buyers/` | ✓ | ✓ |  |  |  |
| buyers | POST | `/api/buyers/` | ✓ | ✓ |  |  |  |
| cases | POST | `/api/cases/:id/analyze` | ✓ | ✓ |  |  |  |
| cases | POST | `/api/cases/:id/upload` | ✓ | ✓ |  |  |  |
| cases | GET | `/api/cases/:id` | ✓ | ✓ |  |  |  |
| cases | GET | `/api/cases/` | ✓ | ✓ |  |  |  |
| cases | POST | `/api/cases/` | ✓ | ✓ |  |  |  |
| cases | POST | `/api/cases/worker/jobs/:id/requeue` | ✓ | ✓ |  |  |  |
| cases | GET | `/api/cases/worker/queue-stats` | ✓ | ✓ |  |  |  |
| compliance | GET | `/api/compliance/audit-summary` | ✓ | ✓ |  |  |  |
| compliance | GET | `/api/compliance/audit-trail` | ✓ | ✓ |  |  |  |
| dashboard | GET | `/api/dashboard/pipeline` | ✓ | ✓ |  |  |  |
| dashboard | GET | `/api/dashboard/recent-activity` | ✓ | ✓ |  |  |  |
| dashboard | GET | `/api/dashboard/stats` | ✓ | ✓ |  |  |  |
| decision-engine | POST | `/api/decision-engine/leads/:id/recompute` | ✓ | ✓ |  |  |  |
| decision-engine | GET | `/api/decision-engine/portfolio` | ✓ | ✓ |  |  |  |
| decision-engine | POST | `/api/decision-engine/recompute-all` | ✓ | ✓ |  |  |  |
| decision-engine | GET | `/api/decision-engine/settings` | ✓ | ✓ |  |  |  |
| decision-engine | PUT | `/api/decision-engine/settings` | ✓ | ✓ |  |  |  |
| document-templates | GET | `/api/document-templates/:id/preview` | ✓ | ✓ |  |  |  |
| document-templates | DELETE | `/api/document-templates/:id` | ✓ | ✓ |  |  |  |
| document-templates | GET | `/api/document-templates/:id` | ✓ | ✓ |  |  |  |
| document-templates | PUT | `/api/document-templates/:id` | ✓ | ✓ |  |  |  |
| document-templates | DELETE | `/api/document-templates/assignments/:id` | ✓ | ✓ |  |  |  |
| document-templates | GET | `/api/document-templates/assignments/all` | ✓ | ✓ |  |  |  |
| document-templates | GET | `/api/document-templates/assignments/by-template/:templateId` | ✓ | ✓ |  |  |  |
| document-templates | POST | `/api/document-templates/assignments` | ✓ | ✓ |  |  |  |
| document-templates | GET | `/api/document-templates/` | ✓ | ✓ |  |  |  |
| document-templates | POST | `/api/document-templates/` | ✓ | ✓ |  |  |  |
| document-templates | POST | `/api/document-templates/upload` | ✓ | ✓ |  |  |  |
| documents | DELETE | `/api/documents/:id` | ✓ | ✓ |  |  |  |
| documents | PATCH | `/api/documents/:id` | ✓ | ✓ |  |  |  |
| documents | GET | `/api/documents/` | ✓ | ✓ |  |  |  |
| documents | POST | `/api/documents/highlight` | ✓ | ✓ |  |  |  |
| documents | POST | `/api/documents/` | ✓ | ✓ |  |  |  |
| documents | POST | `/api/documents/redact` | ✓ | ✓ |  |  |  |
| drafting | POST | `/api/drafting/generate-pdf` | ✓ | ✓ |  |  |  |
| drafting | POST | `/api/drafting/generate` | ✓ | ✓ |  |  |  |
| drafting | GET | `/api/drafting/templates` | ✓ | ✓ |  |  |  |
| forms-public | GET | `/api/forms-public/embed/:tortId` |  |  | ✓ |  |  |
| forms-public | GET | `/api/forms-public/preview-blocker.js` |  |  | ✓ |  |  |
| forms-public | GET | `/api/forms-public/preview/:tortId` |  |  | ✓ |  |  |
| forms | POST | `/api/forms/background-check/lead/:id` | ✓ | ✓ |  |  |  |
| forms | POST | `/api/forms/background-check` | ✓ | ✓ |  |  |  |
| forms | GET | `/api/forms/categories` | ✓ |  |  | ✓ |  |
| forms | DELETE | `/api/forms/config/:tortId/fields/:key` | ✓ | ✓ |  |  |  |
| forms | POST | `/api/forms/config/:tortId/fields` | ✓ | ✓ |  |  |  |
| forms | GET | `/api/forms/config/:tortId` | ✓ |  |  | ✓ |  |
| forms | PUT | `/api/forms/config/:tortId` | ✓ | ✓ |  |  |  |
| forms | GET | `/api/forms/config` | ✓ |  |  | ✓ |  |
| forms | POST | `/api/forms/escalate/fbi` | ✓ | ✓ |  |  |  |
| forms | POST | `/api/forms/fraud-check` | ✓ | ✓ |  |  |  |
| forms | POST | `/api/forms/npi-verify` | ✓ | ✓ |  |  |  |
| forms | POST | `/api/forms/submit` | ✓ | ✓ |  |  |  |
| forms | POST | `/api/forms/validate/address` | ✓ |  |  | ✓ |  |
| forms | POST | `/api/forms/validate/email` | ✓ |  |  | ✓ |  |
| health | GET | `/api/health/healthz` |  |  | ✓ |  |  |
| image-objects | GET | `/api/image-objects/:id/integrity` | ✓ | ✓ |  |  |  |
| image-objects | DELETE | `/api/image-objects/:id` | ✓ | ✓ |  |  |  |
| image-objects | GET | `/api/image-objects/:id` | ✓ | ✓ |  |  |  |
| image-objects | PATCH | `/api/image-objects/:id` | ✓ | ✓ |  |  |  |
| image-objects | GET | `/api/image-objects/` | ✓ | ✓ |  |  |  |
| image-objects | POST | `/api/image-objects/` | ✓ | ✓ |  |  |  |
| image-objects | GET | `/api/image-objects/stats` | ✓ | ✓ |  |  |  |
| integrations | POST | `/api/integrations/:id/sync` | ✓ | ✓ |  |  |  |
| integrations | POST | `/api/integrations/:id/test` | ✓ | ✓ |  |  |  |
| integrations | DELETE | `/api/integrations/:id` | ✓ | ✓ |  |  |  |
| integrations | GET | `/api/integrations/:id` | ✓ | ✓ |  |  |  |
| integrations | PATCH | `/api/integrations/:id` | ✓ | ✓ |  |  |  |
| integrations | GET | `/api/integrations/categories` | ✓ | ✓ |  |  |  |
| integrations | GET | `/api/integrations/` | ✓ | ✓ |  |  |  |
| integrations | POST | `/api/integrations/` | ✓ | ✓ |  |  |  |
| integrations | GET | `/api/integrations/presets` | ✓ | ✓ |  |  |  |
| lead-import | GET | `/api/lead-import/batches/:id/duplicates` | ✓ | ✓ |  |  |  |
| lead-import | GET | `/api/lead-import/batches/:id/errors` | ✓ | ✓ |  |  |  |
| lead-import | GET | `/api/lead-import/batches/:id` | ✓ | ✓ |  |  |  |
| lead-import | GET | `/api/lead-import/batches` | ✓ | ✓ |  |  |  |
| lead-import | POST | `/api/lead-import/execute` | ✓ | ✓ |  |  |  |
| lead-import | POST | `/api/lead-import/preview` | ✓ | ✓ |  |  |  |
| lead-sources | DELETE | `/api/lead-sources/:id` | ✓ | ✓ |  |  |  |
| lead-sources | PUT | `/api/lead-sources/:id` | ✓ | ✓ |  |  |  |
| lead-sources | GET | `/api/lead-sources/` | ✓ | ✓ |  |  |  |
| lead-sources | POST | `/api/lead-sources/` | ✓ | ✓ |  |  |  |
| leads | GET | `/api/leads/:id/envelopes` | ✓ | ✓ |  |  |  |
| leads | GET | `/api/leads/:id/fax-results` | ✓ | ✓ |  |  |  |
| leads | POST | `/api/leads/:id/intelligence` | ✓ | ✓ |  |  |  |
| leads | PATCH | `/api/leads/:id/notes` | ✓ | ✓ |  |  |  |
| leads | POST | `/api/leads/:id/qualify` | ✓ | ✓ |  |  |  |
| leads | DELETE | `/api/leads/:id` | ✓ | ✓ |  |  |  |
| leads | GET | `/api/leads/:id` | ✓ | ✓ |  |  |  |
| leads | PATCH | `/api/leads/:id` | ✓ | ✓ |  |  |  |
| leads | GET | `/api/leads/export` | ✓ | ✓ |  |  |  |
| leads | GET | `/api/leads/` | ✓ | ✓ |  |  |  |
| leads | POST | `/api/leads/` | ✓ | ✓ |  |  |  |
| news | GET | `/api/news/financial` | ✓ | ✓ |  |  |  |
| news | GET | `/api/news/mass-tort` | ✓ | ✓ |  |  |  |
| npi | GET | `/api/npi/lookup/:npi` | ✓ | ✓ |  |  |  |
| npi | GET | `/api/npi/search` | ✓ | ✓ |  |  |  |
| ocr | POST | `/api/ocr/ai-fields/result/:id` | ✓ | ✓ |  |  |  |
| ocr | POST | `/api/ocr/ai-fields` | ✓ | ✓ |  |  |  |
| ocr | GET | `/api/ocr/queue-stats` | ✓ | ✓ |  |  |  |
| ocr | GET | `/api/ocr/results/:id` | ✓ | ✓ |  |  |  |
| ocr | GET | `/api/ocr/results` | ✓ | ✓ |  |  |  |
| ocr | POST | `/api/ocr/upload` | ✓ | ✓ |  |  |  |
| paralegals | GET | `/api/paralegals/:id/performance` | ✓ | ✓ |  |  |  |
| paralegals | GET | `/api/paralegals/:id` | ✓ | ✓ |  |  |  |
| paralegals | GET | `/api/paralegals/` | ✓ | ✓ |  |  |  |
| paralegals | POST | `/api/paralegals/` | ✓ | ✓ |  |  |  |
| review-queue | PATCH | `/api/review-queue/:id` | ✓ | ✓ |  |  |  |
| review-queue | GET | `/api/review-queue/` | ✓ | ✓ |  |  |  |
| review-queue | GET | `/api/review-queue/stats` | ✓ | ✓ |  |  |  |
| security | PATCH | `/api/security/alerts/:id/dismiss` | ✓ | ✓ |  |  |  |
| security | GET | `/api/security/alerts` | ✓ | ✓ |  |  |  |
| security | POST | `/api/security/analyze` | ✓ | ✓ |  |  |  |
| security | POST | `/api/security/block-ip` | ✓ | ✓ |  |  |  |
| security | DELETE | `/api/security/blocked-ips/:ip` | ✓ | ✓ |  |  |  |
| security | GET | `/api/security/blocked-ips` | ✓ | ✓ |  |  |  |
| security | PATCH | `/api/security/notifications/:id/acknowledge` | ✓ | ✓ |  |  |  |
| security | GET | `/api/security/notifications` | ✓ | ✓ |  |  |  |
| security | GET | `/api/security/stats` | ✓ | ✓ |  |  |  |
| security | POST | `/api/security/test-alert` | ✓ | ✓ |  |  |  |
| security | POST | `/api/security/webhook-config` | ✓ | ✓ |  |  |  |
| timeline | GET | `/api/timeline/lead/:id` | ✓ | ✓ |  |  |  |
| vendors | DELETE | `/api/vendors/:id` | ✓ | ✓ |  |  |  |
| vendors | GET | `/api/vendors/:id` | ✓ | ✓ |  |  |  |
| vendors | PATCH | `/api/vendors/:id` | ✓ | ✓ |  |  |  |
| vendors | GET | `/api/vendors/` | ✓ | ✓ |  |  |  |
| vendors | POST | `/api/vendors/` | ✓ | ✓ |  |  |  |
| webhooks | POST | `/api/webhooks/_test/envelope-signed` |  |  | ✓ |  |  |
| webhooks | POST | `/api/webhooks/docusign` |  |  | ✓ |  |  |
| webhooks | POST | `/api/webhooks/dropbox-sign` |  |  | ✓ |  |  |
| workflow-settings | GET | `/api/workflow-settings/_options/providers` | ✓ | ✓ |  |  |  |
| workflow-settings | GET | `/api/workflow-settings/:scope` | ✓ | ✓ |  |  |  |
| workflow-settings | GET | `/api/workflow-settings/` | ✓ | ✓ |  |  |  |
| workflow-settings | PUT | `/api/workflow-settings/` | ✓ | ✓ |  |  |  |

