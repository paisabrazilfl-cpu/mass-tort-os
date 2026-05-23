# Mass Tort OS (MTOS) — Complete User Manual

> **This manual is exhaustive and granular.** Every page, button, field, status enum, role, permission, API endpoint, automation node, error code, and audit event in the system is documented below. Cross-references use exact code paths so engineers and operators see the same source of truth.

**Version 2026.05.16** • Built directly from source: `artifacts/api-server/src`, `artifacts/mtos-crm/src`, `lib/db/src/schema`.

> **Owner-level account.** The platform owner is the seeded `super_admin` — the account whose email is set via the `SEED_ADMIN_EMAIL` deploy secret. As `super_admin` they see EVERY firm, lead, case, audit log, integration, and admin panel across the system — including the hidden **Boss-Omega Dark Room** (§13.2), which is invisible to every other role. The role hierarchy is `super_admin > admin > attorney > paralegal > viewer` (§2.1). The billing banner and subscription gate are bypassed for `super_admin` and for any deploy where Stripe is unconfigured.

---

# Part I — Foundations

## 1. How the system is laid out

| Layer | Where it lives | What it does |
|---|---|---|
| CRM web app | `artifacts/mtos-crm` | React 19 + Vite 7 UI you click through. |
| Static + proxy server | `artifacts/mtos-crm/server.mjs` | Production-only Node stdlib server that serves the SPA bundle and reverse-proxies `/api/*` + `/webhook/*` to the api-server (so the SPA's same-origin fetches work across two Railway services). |
| API server | `artifacts/api-server` | Express 5 backend serving `/api/*`. Boot-time fail-closes on missing required env (DATABASE_URL, SESSION_SECRET, ENCRYPTION_KEY_V1) in production/staging. |
| Worker | `artifacts/api-server` (`dev:worker`) or in-process via `INPROC_WORKER=1` | Polls the Postgres job queue and runs background jobs (OCR, e-sign, fax, AI extraction, Fasten sync). |
| Database | PostgreSQL 16 | 49 tables managed by Drizzle ORM via `lib/db/src/schema`. |
| Schema management | `drizzle-kit generate` + `drizzle-kit migrate` (or the in-repo `pnpm --filter @workspace/db run bootstrap`) | SQL files committed under `lib/db/drizzle/`; `migrate` is non-interactive and idempotent via `__drizzle_migrations`. The legacy `drizzle-kit push` is still available but hangs on column-rename prompts in non-TTY environments. |

All `/api/*` calls go through `authMiddleware` then a `requirePermission(...)` or `requireRole(...)` gate. The boot-time route-protection validator (`lib/route-protection.ts`) refuses to start if any non-public route is missing a permission gate.

### 1.1 Deployment topologies

- **Railway (current).** Two services — `api-server` (Node, runs the worker in-process) and `mtos-crm` (static + proxy via `server.mjs`) — plus the Postgres plugin. Per-service config in `artifacts/<svc>/railway.json`; full setup in `RAILWAY.md`. Required env documented in `.env.example`.
- **Replit (legacy).** Deprecated. Removed in commit `a44e86d`.

---

## 2. Identity, authentication, and sessions

### 2.1 The five roles

Defined in `artifacts/api-server/src/lib/rbac.ts` (`UserRole`), in declared order:

| # | Role | Hierarchy weight | Typical user |
|---|------|---|---|
| 1 | `super_admin` | 200 | Platform operator across firms. Has every permission and bypasses firm-scope checks. |
| 2 | `admin` | 100 | Firm owner / IT lead. Has every permission inside their firm. |
| 3 | `attorney` | 75 | Licensed attorney handling cases. |
| 4 | `paralegal` | 50 | Daily lead/case worker. |
| 5 | `viewer` | 25 | Read-only observer (compliance, auditor). |

The `requireRole(...)` middleware grants access if your role's weight ≥ the required role's weight, so `super_admin` and `admin` automatically pass any check.

### 2.2 Email verification gate

A new account **cannot sign in** until they click the email verification link. Login responds:

```json
{
  "status": "error",
  "code": "email_unverified",
  "message": "Please verify your email address before signing in. Check your inbox for the verification link."
}
```

- The verification token is the SHA-256 hash of a 32-byte random hex string.
- Token TTL: **24 hours**. Verified via `GET /auth/verify-email?token=...`.
- Defined in `artifacts/api-server/src/lib/email-verification.ts`.

### 2.3 MFA (TOTP)

- MFA is **required** when the user row has both `mfa_enabled = true` and `totp_secret` populated.
- If `totp_code` is missing on a login attempt for an MFA-enabled user, the API returns:

```json
{ "mfa_required": true, "message": "Please provide your TOTP code" }
```

- The CRM redirects to `/login/mfa` to collect the code, then re-submits.

### 2.4 Dev-mode bypass (do **not** use in production)

In `rbac.ts` lines 524-531, when **all** of these are true the request is allowed without a token and a synthetic admin user is injected:

- `process.env.NODE_ENV === "development"`
- `process.env.MTOS_DEV_LOGIN === "1"`
- No `Authorization` header is present

The synthetic user is `{ id: 0, email: "dev@mtos.local", role: "admin", firm_id: 1 }`. Production NODE_ENV refuses this even if MTOS_DEV_LOGIN is set.

### 2.5 Token model

| Item | Value | Source |
|---|---|---|
| JWT algorithm | HS256 | `rbac.ts:495` |
| Access token TTL | **15 minutes** | `rbac.ts:48` |
| Refresh token TTL | **7 days** (`7*24*60*60*1000` ms) | `rbac.ts:49` |
| `tv` claim | Per-user `token_version` integer in DB | `rbac.ts:412` |
| Revocation | Refresh-token reuse increments `token_version`, invalidating **all** outstanding tokens for that user | `rbac.ts:447-491` |
| Revocation check | `isTokenVersionRevoked` compares JWT `tv` to DB `token_version` | `rbac.ts:504` |

Operationally: when you "Force logout" a user from **Security**, the system bumps their `token_version` and every device they're logged into is kicked.

### 2.6 Login rate-limit

- 5 auth attempts / 15 minutes.
- General API: 100 requests / 15 minutes.
- 429 response: `{ "error": "Too many authentication attempts. Please try again later." }`

---

## 3. Permission catalog (full)

Every permission name in the system, in declared order from `rbac.ts:94-235`. The string in backticks is the wire value (used in audit logs and route matrix).

### 3.1 Leads & cases
- `lead:view:any`, `lead:view:own`, `lead:create`, `lead:update`, `lead:delete`, `lead:qualify`, `lead:export`
- `lead_import:preview`, `lead_import:execute`
- `case:view:any`, `case:view:own`, `case:create`, `case:upload`, `case:analyze`, `case:worker_admin`
- `paralegal:view`, `paralegal:manage`
- `review_queue:view`, `review_queue:resolve`

### 3.2 Forms & decisioning
- `forms:config:view:public`, `forms:config:view`, `forms:config:manage`
- `forms:submit`, `forms:background_check`, `forms:npi_verify`, `forms:fraud_check`, `forms:escalate_fbi`
- `decision_engine:view`, `decision_engine:manage`

### 3.3 Documents, OCR, drafting
- `documents:view`, `documents:create`, `documents:update`, `documents:delete`, `documents:redact`
- `ocr:upload`, `ocr:view`, `ocr:queue_admin`, `ocr:ai_fields`
- `drafting:templates_view`, `drafting:generate`
- `image_objects:view`, `image_objects:manage`, `image_objects:delete`
- `templates:view`, `templates:manage`

### 3.4 Communication & comms config
- `calls:view`, `calls:manage`
- `sms:send`
- `workflow_settings:view`, `workflow_settings:manage`

### 3.5 Operational tooling
- `npi:lookup`
- `news:view`
- `timeline:view`
- `dashboard:view`
- `analytics:view`, `analytics:predictive:lead`
- `medical_records:view`, `medical_records:manage`

### 3.6 Configuration & admin
- `buyers:view`, `buyers:manage`
- `vendors:view`, `vendors:manage`, `vendors:delete`
- `lead_sources:view`, `lead_sources:manage`
- `integrations:manage`
- `users:list`, `users:manage`, `invites:manage`
- `billing:manage`
- `compliance:view`
- `security:manage`
- `api_keys:manage`
- `automations:view`, `automations:manage`, `automations:execute`
- `self_heal:manage`
- `competitive_intel:manage`

### 3.7 Default role → permission map (`ROLE_PERMISSIONS`, `rbac.ts:243-381`)

- **super_admin** receives `Object.values(Permission)` — every permission, and additionally bypasses the per-firm scope check enforced by `lib/firm-scope.ts` so platform operators can support multiple tenants.
- **admin** receives `Object.values(Permission)` — every permission, including any added later, scoped to their own firm.
- **attorney** receives the union of: every `lead:*` (except `delete` is also granted), `case:view:any/create/upload/analyze`, `paralegal:view`, `forms:config:view*`, `forms:submit/background_check/npi_verify/fraud_check/escalate_fbi`, `decision_engine:view`, `buyers:view`, `vendors:view/manage`, `lead_sources:view`, `templates:view`, `workflow_settings:view`, all `documents:*` (incl. `delete`/`redact`), `ocr:upload/view/ai_fields`, `drafting:*`, `image_objects:view/manage`, `npi:lookup`, `news:view`, `timeline:view`, `review_queue:view/resolve`, `dashboard:view`, `analytics:view`, `analytics:predictive:lead`, `calls:view/manage`, `sms:send`, `medical_records:view/manage`.
- **paralegal** receives: `lead:view:own/create/update/qualify`, `lead_import:preview`, `case:view:own/create/upload/analyze`, `forms:config:view:public`, `forms:submit/background_check/npi_verify/fraud_check`, `vendors:view`, `buyers:view`, `lead_sources:view`, `templates:view`, `workflow_settings:view`, `documents:view/create/update/redact`, `ocr:upload/view/ai_fields`, `drafting:*`, `image_objects:view/manage`, `npi:lookup`, `news:view`, `timeline:view`, `review_queue:view`, `dashboard:view`, `analytics:predictive:lead`, `calls:view`, `sms:send`, `medical_records:view/manage`.
- **viewer** receives: `lead:view:own`, `case:view:own`, `forms:config:view:public`, `buyers:view`, `lead_sources:view`, `templates:view`, `workflow_settings:view`, `documents:view`, `news:view`, `dashboard:view`, `calls:view`. Read-only.

> **Promotion rules.** A user can never promote themselves. PATCH `/api/users/:id/role` rejects:
> - role `admin` (admin-elevation is out of scope for the Users page; admins are minted directly).
> - any `target_user_id === actor_user_id` (cannot change own role).
> - cross-firm targets (returns `404` to avoid leaking existence).

---

## 4. Standard error responses

Defined in `artifacts/api-server/src/lib/http-errors.ts`. **Memorize these shapes** — every route returns one of them on failure.

| HTTP | Code | JSON shape |
|---|---|---|
| 401 | `UNAUTHENTICATED` | `{"status":"error","code":"UNAUTHENTICATED","message":"Authentication required"}` |
| 403 | `FORBIDDEN` | `{"status":"error","code":"FORBIDDEN","message":"Insufficient permissions"}` |
| 403 | `email_unverified` | see §2.2 |
| 404 | `not_found` | `{"status":"error","code":"not_found","message":"Not found"}` |
| 422 | `unprocessable` | `{"status":"error","code":"unprocessable","message":"...field-specific..."}` |
| 422 | (Zod failures) | Same shape with field-level `issues[]` array. |
| 429 | rate-limit | `{"error":"Too many authentication attempts. Please try again later."}` |
| 5xx | `internal` | `{"status":"error","code":"internal","message":"Unexpected server error"}` (correlated by `req.id`) |

---

## 5. Cross-cutting building blocks

These show up everywhere; learn them once.

### 5.1 Firm tenancy
Every business table (leads, cases, automation runs, self-heal sessions, …) carries a `firm_id` column. Every authenticated query is scoped by `req.user.firm_id` via the canonical helper `artifacts/api-server/src/lib/firm-scope.ts` (`requireFirmId(req)` reads the value, `leadFirmScope(req)` produces the Drizzle predicate). Cross-firm reads return **404** (never 403, to avoid leaking the row's existence). The legacy `cases` rows are backfilled by `scripts/backfill-cases-firm-id.sql`; new rows are stamped by the create-case worker.

### 5.2 Audit log
`auditLog(entity_type, entity_id, action, details)` writes an immutable row to `audit_log`. Common action strings — see §13.10 for the exhaustive list.

### 5.3 File vault
- Every uploaded file is hashed with **SHA-256** in `saveFile` (`crypto.createHash`).
- Files are stored as `${timestamp}_${sanitized_name}` in case-specific directories — no overwrite, ever.
- `documents.file_url` and `fax_results.vault_path` point to specific immutable instances.
- The vault enforces an **SSRF-safe path** check `assertWithinVault(targetPath)` (`artifacts/api-server/src/lib/vault.ts`).

### 5.4 Encryption at rest
- AES-256-GCM. The active version is **V1**: `CURRENT_KEY_VERSION = 1` in `lib/encryption.ts:27`. V1 reads its key from `ENCRYPTION_KEY_V1` (or the legacy `ENCRYPTION_KEY` env var as a single backwards-compatible fallback). `ENCRYPTION_KEY_V2` is reserved for a future rotation; no row in the database is currently tagged `enc:v2:`.
- AAD (Additional Authenticated Data) is `fieldName:entityId` for lead PII columns (so swapping a ciphertext from another row fails GCM verification), or just `fieldName` for legacy rows pre-Task #8 rebind. Vault-credential rows use the row id as AAD.
- Writes always use `CURRENT_KEY_VERSION`; decrypts read the version embedded in the `enc:v<N>:<hasAAD>:<payload>` header and try the strict (field+entity) AAD first, then field-only, then no AAD, before logging `[DECRYPTION_ERROR]`. Bump `CURRENT_KEY_VERSION` and run `scripts/rotate-encryption-key.ts` to roll forward.

### 5.5 Recursive error fallback (planning surfaces only)
`lib/automations/recursive-retry.ts` (`recursiveRetry({attempt, maxAttempts, maxTotalMs})`) wraps the AI Assistant in **Automations**:

| Guardrail | Value |
|---|---|
| Default max attempts | 3 |
| Hard cap | `ABSOLUTE_MAX_ATTEMPTS = 6` (clamps callers) |
| Wall-clock budget | 30 000 ms (no floor) |
| Circuit breaker | sha256(message + errorCode); bails if two consecutive attempts are identical |
| Perspective shift per attempt | ~20% angle change per retry: gentle reframe → simplify → minimum viable → literal |
| Attempt log | Every attempt logged with duration + outcome and surfaced under `retry.attempts[]` in the response |

> **Out of scope:** runtime workflow node retries. Those need an idempotency story, so failures fall through to the **Review Queue**.

### 5.6 AI Constitution
Single canonical document at `docs/AI_CONSTITUTION.md`. Loaded by `lib/ai-constitution.ts` and auto-injected into every AI helper's system prompt. Served at `GET /api/admin/ai-constitution` (`automations:view` permission; `?format=markdown` for raw text). Bright lines (the AI **never** does these unattended) are listed in §11.5.

### 5.7 AI Resiliency v2 (opt-in)
Layered on top of `recursiveRetry` (§5.5) when `AI_RESILIENCY_V2=1` is set. Default OFF — the wrapper falls back to plain `recursiveRetry` if anything in the resiliency layer throws unexpectedly, so the worst case is "no v2 benefit," never broken AI. Implementation in `lib/ai/`:

| Module | Job |
|---|---|
| `circuit-breaker.ts` | Per-provider CLOSED/OPEN/HALF_OPEN state machine. OPEN fails fast without calling the inner attempt; HALF_OPEN admits exactly one probe; per-provider isolation (an Anthropic outage doesn't trip OpenAI's breaker). |
| `error-classifier.ts` | `classifyError(err) → RETRYABLE | NON_RETRYABLE | BLOCK_UNSAFE | DEFER_EXTERNAL`. HTTP 401/403/400/422 → NON_RETRYABLE; 429/5xx → RETRYABLE; `PolicyViolationError` → BLOCK_UNSAFE; `ProviderUnavailableError` → DEFER_EXTERNAL. |
| `observer.ts` | Emits one `emitAiStateTransition({callId, provider, fromState, toState, attempt, elapsedMs, errorClass, …})` per state change. Collapses rapid identical-state repeats inside a 100 ms window. PII redactor masks SSN, phone, email, DOB (with `-`, `.`, `/` separators), credit cards, and keyword-prefixed last-4 SSNs before they hit the log. 1024-entry LRU keeps memory bounded. |
| `resilient-retry.ts` | The actual wrapper — composes the three above plus a per-attempt `AbortSignal.timeout` (default 30 s). Identical signature to `recursiveRetry` plus a required `provider` field and optional `attemptTimeoutMs` / `callId`. |

### 5.8 Self-Heal (Jules) integration
Wired through `lib/jules-client.ts` and exposed at `/api/admin/self-heal/*` (permission: `self_heal:manage`). Required env on the api-server: `JULES_API_KEY`. Optional: `JULES_DEFAULT_SOURCE` (e.g. `sources/github/<owner>/<repo>`) — set this once or pass `source_name` per request. The route refuses with `503 jules_not_configured` when `JULES_API_KEY` is absent. Sessions are firm-scoped via `requireFirmId`. Plans never auto-merge — the operator must `/:id/approve` (§9.7).

---

# Part II — The CRM, page by page

Each page is documented in the order it appears in the left sidebar. Every entry shows: route, required permission(s), every UI control, the API endpoints it calls, and notable behaviors.

### Sidebar layout

Top → bottom in the expanded sidebar:

1. **Header strip** — logo + collapse toggle.
2. **Route nav** (`components/layout/sidebar-nav.tsx`) — permission-filtered list of pages. Admin-only items (`Boss-Omega Dark Room`, `Self-Heal`, `Decision Engine`, `Competitive Intel`) only render when `user.role === "admin"` or `"super_admin"`.
3. **Favorites panel** (`components/layout/favorites-panel.tsx`) — paste any `http(s)://` URL plus an optional label; click `+` to add, hover an item then click `×` to remove. Stored client-side in `localStorage["mtos.favorites"]` so it's per-device, not synced across logins. URLs are validated against an http/https whitelist before render so a pasted `javascript:` URL gets silently rejected. Items open in a new tab with `rel="noopener noreferrer"`.
4. **User profile chip** — initials + name + role.

---

## 6. Overview

### 6.1 Dashboard — `/`
- **Permission:** `dashboard:view`.
- **Tiles:** New leads (today / 7d / 30d), Qualified rate, Active cases, Revenue (from `cases.data`), Recent activity feed.
- **API:** `GET /api/dashboard/summary`, `GET /api/dashboard/recent-activity`.
- **Tip:** Tiles are clickable — they deep-link to the corresponding list pre-filtered.

### 6.2 Pipeline — `/pipeline`
- **Permission:** `case:view:any` (or `case:view:own`).
- **Layout:** Kanban with columns matching the `cases.status` enum (§7.5).
- **Drag** a case card across columns to PATCH `status`. Every move writes an audit row with `entity_type=case`, `action=status_updated`, and `details={ from, to }`.
- **Filters:** by tort, by paralegal, by `assigned_to`.

### 6.3 Analytics — `/analytics`
- **Permission:** `analytics:view`.
- **Sections:** Funnel (intake → qualified → signed → settled), Source ROI (cost / acquired case), Paralegal throughput, Time-to-qualification distribution, Cost-per-acquired-case.
- **Filters:** date range, tort, source, paralegal.
- **Export:** CSV download.

### 6.4 User Manual — `/user-manual`
- **Permission:** any authenticated user.
- **Content:** this document, rendered with `react-markdown` + `remark-gfm`. Use the section numbers above to jump.

---

## 7. Leads & Cases

### 7.1 Leads — `/leads`
- **Permission:** `lead:view:own` or `lead:view:any`.
- **API:** `GET /api/leads`. Filters: `status`, `tort_type`, `search`, `vendor_id`, `law_firm`, `client_id`, `date_from`, `date_to`.
- **Columns:** ID, Name, Tort, Status, Source, Convexity (badge), Assigned paralegal, Created, Updated.
- **Bulk actions:** Assign (calls `PATCH /api/leads/:id`), Export (`GET /api/leads/export`, capped at 50 000 rows).

### 7.2 New Intake — `/leads/new`
- **Permission:** `lead:create`. Calls `POST /api/leads`.
- **Required fields** (Zod-validated; failure → 422):
  - `first_name`, `last_name`, `date_of_birth` (ISO date), `street_address`, `city`, `state` (2-letter select), `zip`, `phone_primary`, `last_4_ssn` (`^\d{4}$`), `email`, `tort_type`, `diagnosis`, `diagnosis_date` (ISO date), `diagnosis_confirmed` (bool), `was_at_location` (bool), `location_name` (when `was_at_location=true`).
  - **Hospital block** (mandatory): `hospital_name`, `hospital_fax`, `hospital_contact_info`. Missing them → automatic decision-engine `REJECT` (422).
- **De-dup behavior** — on submit, `findExistingLeadForIntake` runs in this exact order:
  1. **Lookup hash:** SHA-256 of `(tort_type|email|phone10)`. Match → short-circuit (matched_by `email`).
  2. **Email match:** case-insensitive on `leads.email` within the same `tort_type`.
  3. **Phone match:** last-10-digit normalization, scans up to 1 000 candidates in the same `tort_type`. Decrypts `phone` and `phone_primary` with field-name as AAD.
  4. **No match → fresh INSERT.**
- **Fill-empty semantics:** when an existing lead matches, only blank fields on the existing row are filled in — non-blank fields are preserved. Same `tort_type` only; the same person across two torts is two leads.

### 7.3 Lead Import — `/lead-import`
- **Permissions:** `lead_import:preview` (preview), `lead_import:execute` (commit).
- **Endpoints:**
  - `POST /api/lead-import/preview` — body `{ csv_data }` → returns column suggestions + first-N row preview with per-row issues.
  - `POST /api/lead-import/execute` — body `{ csv_data, column_mapping, filename }` → returns `202` with `batch_id`. Async.
  - `GET /api/lead-import/batches/:id` — poll for status, success/error counts, per-row error report.
- **Audit:** `import_batch_started`, `error_row_write_failed`.
- **Same de-dup rules as manual intake** apply to every row.

### 7.4 Lead Detail — `/leads/:id`
- **Tabs:** Profile · Medical · Compliance · Documents · Automation · Intelligence.
- **Buttons (conditional on status):**
  - **Run Gatekeeper** — visible when `status="new"`. Calls `POST /api/leads/:id/qualify` (`lead:qualify`).
  - **Execute Retainer** — visible when `status="qualified"`. Triggers the auto-document workflow (§8.5).
  - **Run Intelligence** — calls the predictive endpoint for this lead (§9.4).
  - **Save Notes** — PATCH the `notes` field; writes audit `note_added`.
  - **Export** — single-lead PDF download.

### 7.5 Cases — `/cases` & New Case — `/cases/new`
- **Permission:** `case:view:any` / `case:create`.
- **`cases.status` enum (exhaustive):** `open`, `processing`, `analyzed`, `failed`, `documents_received`, `ready_for_review`, `client_signed`, `filed`, `review_required`, `closed`.
- **Case Detail Tabs (`/cases/:id`):** Overview · Documents · AI Analysis · Audit Trail.
- **Case Detail buttons:** Refresh · Analyze Documents (enqueues background job) · Upload to Vault.

### 7.6 Job Queue — `/job-queue`
- **Permission:** `case:worker_admin`.
- Live view of every async job: queued, running, succeeded, failed, retrying, dead-letter.
- Common job types: `process_fax`, `analyze_case`, `send_workflow_email`, `send_esign_packet`, `send_fax_request`, `competitive_intel_refresh`.
- **Actions:** retry failed, view payload, view error stack.

### 7.7 Calls — `/calls`
- **Permission:** `calls:view` (mutate: `calls:manage`).
- Sourced from Vapi webhooks (§13.4): every inbound call lands here with transcript, recording URL, qualification verdict, escalation flag.
- **Columns:** Caller, DID, Started, Duration, Verdict (qualify / reject / hold / escalated), Lead linkage.

### 7.8 Paralegals — `/paralegals`
- **Permission:** `paralegal:view` (manage: `paralegal:manage`).
- **Per-paralegal columns:** Name, Active cases, Assigned torts (multi-select), Licensed states (multi-select), Available (toggle).
- **Round-robin logic** (`paralegals.ts` + n8n flow `01-lead-assign.json`):
  1. `GET /api/paralegals?sort=load_asc&tort=...&state=...` returns eligible candidates ordered by `active_cases ASC`. Wildcards: `assigned_torts IS NULL` matches any tort; `licensed_states IS NULL` matches any state.
  2. `active_cases` is computed live as `count(*) WHERE status NOT IN ('signed','rejected')`.
  3. The first row (lowest load that matches) wins. n8n issues `PATCH /api/leads/:id` with `assigned_to`.

### 7.9 Review Queue — `/review-queue`
- **Permissions:** `review_queue:view`, `review_queue:resolve`.
- Every item the system couldn't auto-decide: held qualifications, conflicting documents, low-confidence AI extractions, failed automation runs.
- **Per item:** entity, reason, priority, system reasoning trace, accept / override / reject buttons. Every override is audited.

---

## 8. Document Workflow

### 8.1 Web Forms — `/web-forms`
- **Permissions:** `forms:config:view` (read), `forms:config:manage` (write).
- **Endpoints:**
  - `GET /api/web-forms/:tortId/embed.js` — public, returns the embed snippet.
  - `POST /api/web-forms/:tortId/submit` — public, body = lead fields + `trustedform_cert_url`.
- **Embed snippet:** `<script src=".../api/web-forms/:slug/embed.js" data-form-id=":slug"></script>`.
- TrustedForm cert is captured from the hidden field at submit time and saved to `leads.trustedform_cert_url`.
- TCPA snapshot persists `leads.tcpa_text` (the exact consent text shown) and `leads.tcpa_consent` (boolean).

### 8.2 Buyers — `/buyers`
- **Permissions:** `buyers:view`, `buyers:manage`.
- A "buyer" = a third party you sell unqualified leads to.
- **Webhook signing scheme:**
  - Header: `X-MTOS-Signature`
  - Algorithm: `HMAC-SHA256` over `JSON.stringify(payload)`
  - Payload: lead object, event `lead.created`.
- **Selection:** When a lead matches multiple buyers, eligible buyers are sorted by `bid_price DESC` (highest bid wins). Logic in `lib/lead-delivery-service.ts`.

### 8.3 Doc Templates — `/document-templates`
- **Permissions:** `templates:view`, `templates:manage`.
- **`template_type` values:** `hipaa_authorization`, `retainer_agreement`, `medical_records_request`, `demand_letter`, `client_intake_summary`.
- **Sources:** `pdf` (uploaded PDF with merge tags) or `ai` (LLM-generated from a prompt, evaluated against `TEMPLATE_PROMPTS` in `drafting-ai.ts`).
- **Merge-tag syntax:** `{{field_name}}`. Common tags: `{{first_name}}`, `{{last_name}}`, `{{tort_type}}`, `{{date_of_birth}}`, `{{diagnosis}}`, `{{diagnosis_date}}`, `{{hospital_name}}`, `{{hospital_fax}}`. Any column on `leads` is reachable.
- **Endpoints:**
  - `GET /api/document-templates` · `POST /api/document-templates` · `POST /api/document-templates/upload` (PDF → returns `storage_path`) · `POST /api/document-templates/assignments`.

### 8.4 Assignment Matrix — `/template-assignments`
- **Row shape:** `(template_id, buyer_id, tort_type)` upserted via `POST /api/document-templates/assignments`.
- **Resolution order** when a lead qualifies:
  1. Buyer-specific override.
  2. Tort-wide default.
  3. Template `active` flag must be true.

### 8.5 Workflow Settings — `/workflow-settings`
- **Permissions:** `workflow_settings:view`, `workflow_settings:manage`.
- **Six provider categories**, each with a picker that reads from the integrations vault. The full list registered in the lazy registries (`lib/{voice,sms,email,fax,ai}/index.ts`):

| Category | Providers (registered) |
|---|---|
| **Voice** (5) | `vapi`, `retell_ai`, `bland_ai`, `elevenlabs`, `synthflow` |
| **SMS** (6) | `twilio`, `telnyx_sms`, `bandwidth`, `plivo`, `messagebird`, `sinch` |
| **Email** (6) | `sendgrid`, `postmark`, `resend`, `mailgun`, `aws_ses`, `brevo` |
| **Fax** (5) | `srfax`, `efax`, `phaxio`, `documo`, `telnyx_fax` |
| **LLM** (11) | `anthropic`, `openai`, `google_gemini`, `openrouter`, `groq`, `deepseek`, `perplexity`, `mistral`, `cohere`, `xai_grok`, `fireworks_ai` |
| **E-sign** (2) | `dropbox_sign`, `docusign` |

- **Hard fallback rule:** When a chosen LLM provider returns a non-retryable error, the system silently falls back to the **Anthropic env-key adapter** so workflows do not dead-stop.
- **Endpoints:** `GET /api/workflow-settings`, `GET /api/workflow-settings/:scope`, `PUT /api/workflow-settings/`.

### 8.6 Auto-Document Workflow (background)
- **Trigger 1:** `lead.status` transitions to `approved` → `enqueueLeadApprovalPackets()` dispatches every enabled (template × tort × buyer) row in the Assignment Matrix as e-sign packets.
- **Trigger 2:** `envelope.status` transitions to `signed` → if the template has `triggers_med_records_request: true`, a fax to `lead.hospital_fax` is enqueued.
- **E-sign providers**:
  - Dropbox Sign — `POST /signature_request/send`, `file[0]` field, Basic auth.
  - DocuSign — `POST /v2.1/accounts/{id}/envelopes`, `documentBase64`, OAuth2 Bearer.
- Idempotency for both is enforced with a Postgres advisory lock keyed on the envelope id.

---

## 9. Automation

### 9.1 Automations editor — `/automations`
- **Permissions:** `automations:view`, `automations:manage`, `automations:execute`.
- React Flow drag-and-drop. The full **node catalog** is enumerated in §13.1.
- **Endpoints:**

| Method | Path | Permission | Notes |
|---|---|---|---|
| `GET` | `/api/automations/node-catalog` | `automations:view` | Returns `{ nodes: NODE_CATALOG }`. |
| `GET` | `/api/automations/` | `automations:view` | Lists workflows. |
| `GET` | `/api/automations/:id` | `automations:view` | Includes `graph`. |
| `POST` | `/api/automations/` | `automations:manage` | Body: `{ name, description, graph, enabled, trigger_type, trigger_config, tags }`. |
| `PUT` | `/api/automations/:id` | `automations:manage` | Partial body allowed. |
| `DELETE` | `/api/automations/:id` | `automations:manage` | |
| `POST` | `/api/automations/:id/run` | `automations:execute` | Body: `{ input: {...} }`. |
| `GET` | `/api/automations/:id/runs` | `automations:view` | Recent run history. |
| `GET` | `/api/automations/runs/:runId` | `automations:view` | Includes `step_log`. |
| `POST` | `/api/automations/assist` | `automations:manage` | Body: `{ prompt, currentGraph?, mode: 'replace'|'patch' }`. |

### 9.2 Executor rules
- `MAX_STEPS = 200` per run (infinite-loop guard).
- Branch routing: handlers return `{ __branch, value }`; the executor follows the edge whose `sourceHandle === __branch`. Branches are validated against the catalog's declared `outputs`; unknown handles → `assist_catalog_violation` at AI-assist time, run-time mismatch → run fails.
- Timeouts:
  - JS expression eval (`vm.runInContext`): **1 000 ms**.
  - JS / Python / Bash / PowerShell script nodes: **`timeoutMs` param, default 5 000 ms**; spawn default 15 000 ms.
- Errors caught at run loop level → `runStatus = "failed"`, error written to `automation_runs.error`, terminate.

### 9.3 AI Assistant (`/assist`) failure modes
1. `llm_unavailable` — provider error.
2. `assist_invalid_json` — LLM returned non-JSON.
3. `assist_bad_shape` — JSON didn't match `assistGraphSchema`.
4. `assist_catalog_violation` — references unknown node types or invalid `sourceHandle`.

All four are converted into structured `AttemptOutcome`s and fed to `recursiveRetry` (§5.5). Every attempt is surfaced in the response under `retry.attempts[]`.

### 9.4 Persistence (`lib/db/src/schema/automations.ts`)
- **`automation_workflows`:** `id`, `firm_id`, `name`, `description`, `graph` (jsonb), `enabled` (bool), `trigger_type`, `trigger_config` (jsonb), `tags` (jsonb), `created_by_user_id`.
- **`automation_runs`:** `id`, `workflow_id`, `firm_id`, `status` (`running` / `completed` / `failed`), `trigger_source`, `input`, `output`, `step_log` (jsonb array — one entry per node with `node_id`, `started_at`, `completed_at`, `outcome`, `error?`), `error`, `started_by_user_id`, `started_at`, `completed_at`.

### 9.5 Script-node sandbox
- **JS** runs in a `node:vm` context. Available globals: `input`, `vars`, stubbed `console.log`. **No** `process`, `require`, `fs`, network. SSRF-safe.
- **Python / Bash / PowerShell** run via `node:child_process.spawn`. Default timeout 15 s. `stdin` receives serialized `input`. Requires explicit `approved: true` in node params before execution.
- **Outbound URL guard:** `assertSafeOutboundUrl` blocks RFC1918, loopback, and cloud metadata IPs.
- **Secret redaction:** outputs are scanned for `apikey`, `token`, `bearer`, etc. and masked.

### 9.6 n8n / API Setup — `/n8n-setup`
- **Permission:** `api_keys:manage`.
- **Endpoints:**
  - `GET /api/admin/api-keys` — list service-account keys.
  - `POST /api/admin/api-keys` — body `{ name, scopes[] }` → returns `mtos_...` plaintext **once** (never shown again).
  - `DELETE /api/admin/api-keys/:id` — revoke.
  - `GET /api/admin/api-keys/:id/audit` — usage log.
  - `GET /api/admin/api-keys/_meta/scopes` — discoverable scope list.
- **Scopes:** `leads:read`, `leads:write`, `automations:run`, `cases:read` (and others enumerated by `_meta/scopes`).
- **Event catalog:** `GET /api/admin/event-catalog` and `GET /api/admin/event-catalog/openapi.yaml` describe every webhook event you can subscribe to.

### 9.7 Self-Heal (Auto-Fix) — `/self-heal`
- **Permission:** `self_heal:manage`.
- **Mechanism:** Submits a `prompt` to the **Jules** coding agent. Jules returns a plan / PR. MTOS never auto-merges — the operator must `/:id/approve`.
- **`self_heal_sessions` lifecycle:** `pending` → `dispatched` → `awaiting_approval` → `approved` (or `rejected`).
- **Endpoints (`/api/admin/self-heal`):** `GET /config`, `GET /`, `POST /`, `GET /:id`, `POST /:id/messages`, `POST /:id/approve`, `POST /:id/refresh`.
- **Required env:** `JULES_API_KEY` (request via Integrations if missing).

### 9.8 Competitive Intel — `/competitive-intel`
- **Permission:** `competitive_intel:manage`.
- **Backed by:** SerpAPI's `google_ads_transparency_center` engine. Requires `SERPAPI_API_KEY`.
- **Endpoints (`/api/admin/competitive-intel`):**
  - `GET /config` — returns `{ configured: boolean }`.
  - `POST /lookup` — body `{ query | advertiser_id, region? }` → live SerpAPI fetch. Audited.
  - `GET /watchlist` — list watched advertisers (firm-scoped).
  - `POST /watchlist` — add advertiser. Audited.
  - `DELETE /watchlist/:id` — remove. Audited.
  - `POST /watchlist/:id/refresh` — re-snapshot. **Audit only when `last_ad_count` changes** (no spam).
- **Tabs:** **Lookup** (search + ad-card grid) · **Watchlist** (pinned firms with refresh button).
- **Failure modes:** SerpAPI 403/401 → `serpapi_auth`, 200 with `error` payload → 422 `serpapi_logical_error`, network timeout → `serpapi_timeout` (15 s AbortController).
- **API key never logged** — `?api_key=...` is stripped from URLs in `serpapi-client.ts` before logging.

### 9.9 Form API Directory — `/forms-api`
- **Permission:** `forms:config:view`.
- Public-facing API documentation for the embeddable form engine. Useful for vendors building landing pages.

---

## 10. Documents

### 10.1 Documents — `/documents`
- **Permissions:** `documents:view/create/update/delete/redact`.
- **`documents` table columns:** `id`, `lead_id` (FK, cascade), `document_type`, `file_name`, `file_url`, `signed`, `signed_at`, `notes`, `created_at`.
- **Endpoints:**
  - `GET /api/documents?lead_id=...` — list.
  - `GET /api/documents/:id/view` — redirects to `file_url` (or renders a `pdf-lib` placeholder if no file is attached).
  - `POST /api/documents` — body `{ lead_id, document_type, file_name, file_url, signed?, signed_at?, notes? }`.
  - `PATCH /api/documents/:id` — partial update.
  - `DELETE /api/documents/:id` — hard delete (record only; file in vault remains).
  - `POST /api/documents/redact` — body `{ pdf_base64, rules[] }` → returns redacted PDF.

### 10.2 OCR Inbox — `/ocr-inbox`
- **Permissions:** `ocr:upload`, `ocr:view`, `ocr:queue_admin`, `ocr:ai_fields`.
- **`fax_results.status` enum (exhaustive):** `pending` (queued), `processing` (worker active), `done` (success), `error` (failed).
- **Endpoints:**
  - `POST /api/ocr/upload` — body `{ file_name, image_base64 }` → enqueues `process_fax` job.
  - `GET /api/ocr/results` — full inbox.
  - `GET /api/ocr/queue-stats` — counts by status.
  - `POST /api/ocr/results/:id/reprocess` — reset fields, re-enqueue.
  - `POST /api/ocr/ai-fields` — immediate inline extraction from base64/text (no job).

### 10.3 Doc Review — `/doc-review`
- **Permission:** `documents:update` + `ocr:ai_fields`.
- Side-by-side: PDF preview on the left, extracted-field editor on the right with bounding-box highlighting on click.
- Save → updates `fax_results` record, transitions to `done`, attaches to the matched case in **Documents**.

### 10.4 Drafting AI — `/drafting`
- **Permissions:** `drafting:templates_view`, `drafting:generate`.
- Pick a case → pick a template type → generate → human-edit → save as draft → export to Word.
- The model uses `TEMPLATE_PROMPTS` in `drafting-ai.ts` and refuses to assert facts not present in the case file.

---

## 11. Tools

### 11.1 NPI Lookup — `/npi-lookup`
- **Permission:** `npi:lookup`. Uses the public CMS NPPES Registry — no API key required.
- **Endpoints:**
  - `GET /api/npi/search` — params: `npi_number`, `first_name`, `last_name`, `city`, `state`, `specialty`.
  - `POST /api/npi/verify` — body `{ npi, expected: { name, city, ... } }` → fuzzy-match scores.
- **UI tabs:** Search · Verify.
- **Result columns:** NPI · Name · Credential · Specialty · Location (expand for full address/phone).
- **Verify scoring outputs:** `identity_score` (0-1), `city_match` (bool), `state_match` (bool), `specialty_match` (bool).

### 11.2 Form Engine — `/form-engine`
- **Permissions:** `forms:config:view/manage`.
- Drag-and-drop builder with field types: `text`, `email`, `tel`, `date`, `number`, `select`, `textarea`, `checkbox`, `state`.
- TCPA consent text editor + TrustedForm toggle.
- Preview pane and embed snippet generator (§8.1).

### 11.3 Decision Engine — `/decision-engine` (settings: `/decision-engine/settings`)
- **Permissions:** `decision_engine:view/manage`.
- **Architecture:** Pure JS in `lib/decision-engine.ts`. Parameters live in `form_configurations` and `decision_engine_settings` tables.
- **Asymmetric risk framework:** compares **Downside USD** (CPL + Attorney Time) vs **Upside USD** (Settlement Midpoint × Retention Rate × Severity Multiplier).
- **Verdict outputs (`leads.convexity_*` columns):**
  - **Classification:** `convex` (favorable), `neutral`, `concave` (unfavorable).
  - **Action:** `execute`, `modify`, `reject`, `review`.
- **AI verification step:** `lib/ai-extract.ts` runs an LLM check of clinical details against vault documents and emits "Reliability" + "Truthfulness" scores.

### 11.4 Praxis Predictive Scoring — `/predictive`
- **Permission:** `analytics:predictive:lead`.
- **Endpoints:** `GET /api/analytics/predictive/batch`, `GET /api/analytics/predictive/lead/:id`, `GET /api/analytics/predictive/model`.
- **What it is:** a deterministic **weighted-feature scorer**, NOT a trained machine-learning model. The `total_training_samples` field name is a legacy misnomer kept for API stability — the actual value is "leads scored" (the front-end label was updated to reflect this; `lib/predictive-scoring.ts:14-15`). The `model_accuracy` field is an honest backtest against signed-vs-rejected outcomes, not an ML training metric.
- **Output for a lead:** `conversion_probability` (0-100), `risk_score` (0-100), `quality_tier` ∈ {`platinum`, `gold`, `silver`, `bronze`, `unqualified`}, plus a positive/negative-impact factor list derived from the same feature weights that produced the score.
- **Inputs used:** `leads` columns — fraud_score, npi_verified, diagnosis_confirmed, was_at_location, presence of email/phone/address, ad_spend, source.

> **Marketing note.** Do not market this as "trained AI" or "machine-learning predictive model." It is a hand-tuned weighted scorer with backtest accuracy reporting. "Predictive scoring" / "lead-quality scoring" / "explainable scoring" are accurate; "trained on your data" / "ML model" are not.

### 11.5 Bright lines (always require a human)
The AI / system will **never** do the following unattended:
- Final qualification decision.
- Sending an e-sign packet.
- Purchasing PACER documents.
- Changing TCPA consent language.
- Sending a HIPAA release.
- Accepting / declining a settlement.
- Mass operations spanning many leads/cases at once.

A human always confirms these. This is enforced via the AI Constitution (§5.6).

### 11.6 Timeline — `/timeline`
- **Permission:** `timeline:view`.
- **Endpoint:** `GET /api/timeline/lead/:id` — aggregates intake, OCR, NPI, signature events.
- **Event categories:** `personal`, `exposure`, `diagnosis`, `legal`, `verification`, `compliance`, `document`.
- **UI:** searchable lead picker + chronological card list with Date · Title · Category badge · Source badge.

### 11.7 Background Check Hub
Not its own page — appears as a button on every lead. Fans out across **eleven verification lanes** (`lib/bg-hub/hub.ts:31-43`), each reporting honestly **PASS / FAIL / REVIEW_REQUIRED / NOT_RUN**. The hub exposes two aggregate verdicts on the result so the UI can distinguish "all automated checks cleared" from "every lane, including manual-lookup lanes, cleared":

- `final_status` — strict aggregate over EVERY lane, including the 4 advisory stub lanes that always REVIEW. This is the gate to use for hard intake decisions.
- `final_status_live_lanes_only` — aggregate restricted to lanes with a live data adapter. When this is PASS the operator can honestly say "the system actually screened and found nothing." See `lib/bg-hub/hub.ts:80-90`.

Each lane result also carries an optional `manual_action_urls: [{label, url, note}]` array of **prefilled smart-links** (`lib/bg-hub/smart-links.ts`) so the operator can run any remaining manual lookups in one click rather than typing the name into five public-records portals.

#### Lane inventory

| # | Lane (`lib/bg-hub/hub.ts`) | Status | What it checks |
|---|---|---|---|
| 1 | `address` | **LIVE** | Internal validator (`lib/address-validator.ts`) — format + USPS-style + state-code normalization. |
| 2 | `email` | **LIVE** | MX + format + curated 40-domain disposable list + role-based local-part detection (`lib/bg-hub/email-enrichment.ts`). |
| 3 | `phone` | **LIVE** | Phone-format validation only. Carrier + line-type live in `phone_provenance` below. |
| 4 | `phone_provenance` | **LIVE** (requires Telnyx) | Telnyx Number Lookup. Returns line type (mobile / fixed_voip / non_fixed_voip / toll_free), carrier, and a derived burner-risk verdict. Flags non-fixed-VOIP, known burner carriers (TextNow / Google Voice / Pinger / Bandwidth), and recently-ported numbers. Reuses the existing `telnyx` integration row's `api_key` — no separate signup. (`lib/bg-hub/phone-provenance.ts`) |
| 5 | `residency` | **STUB + smart-link** | No live county-property-records adapter. The lane emits a smart-link to the lead's state/city property-records portal (FL / TX / CA deep-linked; other states fall through to a search-engine bang). Full automation requires a paid integration (Smarty / Lob NCOA / ATTOM). |
| 6 | `criminal_court` | **LIVE** | CourtListener REST v4 (federal + state criminal records) + **free Treasury OFAC SDN screening** (`lib/ofac-treasury.ts`). The legacy paid `search.ofac-api.com` path is preserved behind `OFAC_USE_TREASURY=0`. |
| 7 | `incarceration` | **STUB + smart-link** | Federal BOP has no public API. The lane emits smart-links to BOP's inmate locator and VINELink (~46 state DOCs). Full automation requires VINELink partner API. |
| 8 | `sex_offender_nsopw` | **HYBRID** | When Garbo is configured (see below) the lane runs a live FCRA-compliant screen and emits `garbo_sex_offender_hit` (FAIL) or `garbo_unreachable` (REVIEW). When Garbo is NOT configured, the lane emits a prefilled NSOPW smart-link the operator clicks manually — NSOPW's TOS forbids server-side scraping but a human-clicked prefilled bookmark is compliant. |
| 9 | `attorney` | **STUB + smart-link** | State bar lookups are state-by-state. Deep-links wired for CA, NY, TX, FL, IL, PA, OH, GA, NC, WA; other states fall through to a search-engine bang. Full automation requires Martindale-Hubbell (LexisNexis) or per-state bar API integrations. |
| 10 | `business_entity` | **LIVE** (SEC EDGAR) | Live SEC EDGAR lookup against `data.sec.gov` company-tickers index (`lib/bg-hub/sec-edgar.ts`) — covers ~10K SEC-registered entities (public companies, large LLCs, Reg-D filers). Returns CIK / ticker / per-entry EDGAR URL. PASS on hit; small unregistered LLCs surface a state SoS smart-link for manual confirmation. |
| 11 | `pacer_federal` | **LIVE** (requires PACER credentials) | PACER PCL Search API (`lib/pacer/pcl-client.ts`). Per-page billing applies on PACER's side. Hits never auto-FAIL — they surface as REVIEW with the docket URL because PCL returns party names without identity-confirming metadata. |

#### Stub lanes (`lib/bg-hub/escalation.ts:STUB_LANES`)

The four lanes pinned to `REVIEW_REQUIRED` regardless of adapter output: `residency`, `incarceration`, `sex_offender_nsopw` (when Garbo is not configured), and `attorney`. Adding a live adapter for one of these requires removing it from `STUB_LANES` so the flag taxonomy can let it resolve to PASS.

#### Garbo integration (premium, replaces NSOPW stub)

Garbo (https://garbo.io) is an API-first, FCRA-compliant background-check provider. When the operator pastes an API key into **Settings → Integrations → Garbo**, the `sex_offender_nsopw` lane switches from smart-link-only to a live screen on the next bg-hub run. See `lib/bg-hub/garbo.ts` for the adapter scaffold; three lines marked `OPERATOR-CONFIRM` need the actual endpoint + request shape from Garbo's developer docs.

#### Tort-aware lane gating (`lib/bg-hub/tort-policy.ts`)

Not every tort needs every lane. Roblox / Discord / Snap / Meta / Instagram / Character.ai / TikTok (`child_safety` category) skip `business_entity` and `attorney` and mark `incarceration` / `pacer_federal` / `residency` as advisory (run but never gate intake). Camp Lejeune / Roundup / talc / hair relaxer / PFAS / hernia mesh / Bard PowerPort (`medical_injury`) run every lane. Data-breach torts skip every medical-style lane. Securities torts skip identity lanes. The default for an unrecognized tort slug is **run everything** (safer than skipping).

The hub signature is `runBackgroundCheckHub(lead, { tortSlug })`. Skipped lanes are **omitted** from the response entirely; advisory lanes run but their REVIEW/FAIL results are downgraded to NOT_RUN so they're informational only.

---

## 12. Configuration

### 12.1 Vendors — `/vendors`
- **Permissions:** `vendors:view/manage/delete`.
- **Vendor types:** `lead_gen`, `law_firm`, `marketing`, `referral`, `other`.
- Standard CRUD + contract attach + spend tracking.

### 12.2 Firm Settings — `/firm-settings`
- **Permission:** admin.
- Firm name, address, EIN, default sender identity (must be SendGrid-verified, see §13.6 troubleshooting), branding (logo upload), default signature block.

### 12.3 Users — `/users`
- **Permissions:** `users:list`, `users:manage`, `invites:manage`.
- **Endpoints:**
  - `GET /api/users` — firm member list.
  - `PATCH /api/users/:id/role` — admin only; body `{ role: 'attorney'|'paralegal'|'viewer' }`. Promotion-rule failures: §3.7. Successful change writes audit `entity_type=user, action=role_changed, payload={previous_role, new_role}` and bumps `token_version` (kicks all sessions).
  - `POST /api/auth/firm-invites` — mint a one-time registration link.
- **Columns:** ID, Name, Role badge, MFA status, Last login.

### 12.4 Integrations — `/integrations`
- **Permission:** `integrations:manage`.
- **Firm scope:** every integration row carries `firm_id`. CRUD is AND-scoped via `requireFirmId(req)` (`routes/integrations.ts`). Cross-firm reads return 404; admin in Firm A cannot read or rotate Firm B's keys.
- **Categories in the vault:** `ai_llm`, `esignature`, `voice_ai`, `sms`, `email`, `fax`, `ocr`, `identity`, `payments`, `background_check`, `web_search`, `court_records`.
- **Encryption:** AES-256-GCM at the active key version (currently V1 — see §5.4 for rotation policy). AAD = integration row id.
- **Decrypt path:** `getIntegrationCredentialsById(id, firmId)` decrypts on demand. Plaintext is never persisted, never logged. Optional `firmId` argument scopes the lookup to that firm — passing `undefined` (legacy callers) logs a warning.
- **Workflow:** Add → Test connection → Mark active → choose in **Workflow Settings** for the categories where you want it used.
- **Sync handler registry (`lib/integration-sync.ts`).** `POST /api/integrations/:id/sync` delegates to a per-provider registry. Providers without a registered handler return **HTTP 501** with `syncable_providers: [...]` so the UI can hide / disable the Sync button instead of running a no-op. Fasten is registered today (sync runs per-connection via `fasten_records_sync` jobs); other providers are event-driven and have no pull-style sync.
- **Garbo (Background Check).** Paste `api_key` + optional `api_url` to enable the **`sex_offender_nsopw` lane to switch from smart-link manual workflow to a live FCRA-compliant screen** on the next bg-hub run (§11.7). See `lib/bg-hub/garbo.ts`.

### 12.5 Billing — `/billing`
- **Permission:** `billing:manage`.
- **Endpoints:** `GET /api/billing/subscription`, `POST /api/billing/checkout` (returns Stripe Checkout session URL).
- **UI:** plan tier, usage meters (calls / AI tokens / faxes), invoice history, payment-method management.

### 12.6 Compliance — `/compliance`
- **Permission:** `compliance:view`.
- TCPA / HIPAA / consent dashboard. Per-lead consent records, opt-outs, retention timers.
- **Search:** by phone or email — returns full consent history across leads.
- **Export:** compliance report CSV.

### 12.7 Security — `/security`
- **Permission:** `security:manage`.
- **Endpoints:** `GET /api/security/stats`, `POST /api/security/block-ip`.
- **Features:** Token revocation (per-user `token_version` bump), MFA enforcement toggle, rate-limit settings, AI threat-analysis log, login history.
- **Defaults:** General API 100/15min · Auth 5/15min.

---

## 13. News, BOS-OMEGA, and reference appendices

### 13.1 News — `/news` (Tort) and `/financial-news` (Financial)
- **Permission:** `news:view`.
- **Endpoints:** `GET /api/news/mass-tort`, `GET /api/news/financial`.
- **Sources & cadence:**
  - `news.google.com/rss/search?q=...` — queries: mass tort, pharma, MDL, product liability, toxic tort.
  - `finance.yahoo.com/news/rssindex`, MarketWatch RSS, CNBC RSS.
  - **Cache TTL:** 10 minutes (server-side).

### 13.2 Dark Room — `/dark-room` (admin only, BOS-OMEGA)
- Admin diagnostic / red-team console. Bypasses some normal guards but is fully audited (`entity_type=dark_room`).
- **Endpoints:** `GET/POST /api/admin/dark-room`, `PATCH/DELETE /api/admin/dark-room/:id`.

---

## 13.3 Full automation node catalog

**Triggers** — workflow entry points; one output each unless noted.

| ID | Display | Params |
|---|---|---|
| `trigger.manual` | Manual Trigger | (none) — operator click. |
| `trigger.webhook` | Webhook | `path` (req), `secret`. |
| `trigger.schedule` | Schedule (Cron) | `cron`. |
| `trigger.lead_created` | On Lead Created | `tort` filter. |
| `trigger.form_submitted` | On Web Form Submitted | `formId`, `tort`. |
| `trigger.inbound_call` | On Inbound Call | `didNumber`. |
| `trigger.inbound_sms` | On Inbound SMS | `keyword`. |
| `trigger.inbound_email` | On Inbound Email | `toAddress`, `subjectContains`. |
| `trigger.inbound_fax` | On Inbound Fax | `didNumber`. |
| `trigger.document_signed` | On Document Signed | `templateId`. |
| `trigger.case_status_changed` | On Case Status Change | `fromStatus`, `toStatus`. |
| `trigger.ocr_completed` | On OCR Completed | (none). |

**Logic**

| ID | Display | Outputs | Params |
|---|---|---|---|
| `logic.if` | If / Else | `true`, `false` | `expression` (JS, 1 s timeout). |
| `logic.switch` | Switch | `match`, `default` | `key` (path), `cases` (JSON map). |
| `logic.loop` | Loop (forEach) | `item`, `done` | `arrayPath`, `maxIterations`. |
| `logic.delay` | Delay | 1 | `seconds` (capped 60 s in runtime). |

**Data**

| ID | Display | Params |
|---|---|---|
| `data.set` | Set Variable | `name`, `value` (writes to `vars`). |
| `data.transform` | Transform (JS) | `code` (JS body). |
| `data.regex` | Regex Extract | `text`, `pattern`, `flags`. |
| `data.json_path` | JSONPath / Pick | `path`. |
| `data.csv_parse` | CSV → JSON | `text`, `delimiter`. |

**CRM (side effects on the database)**

| ID | Outputs | What it does |
|---|---|---|
| `crm.create_lead` | 1 | DB insert. |
| `crm.update_lead` | 1 | DB update. |
| `crm.qualify_lead` | `qualified`, `rejected`, `review` | Runs decision engine. |
| `crm.create_case` | 1 | DB insert. |
| `crm.add_note` | 1 | Audit log. |
| `crm.audit_log` | 1 | Custom audit row. |
| `crm.assign_paralegal` | 1 | Round-robin if `paralegalId` blank. |
| `crm.set_lead_status` | 1 | Sets `leads.status`. |
| `crm.send_to_review_queue` | 1 | Routes item to operator. |
| `crm.background_check` | `clear`, `flagged`, `error` | Fans out 9-lane check. |
| `crm.npi_lookup` | 1 | NPPES API call. |
| `crm.decision_engine` | `qualified`, `rejected`, `review` | Full deterministic scoring. |
| `crm.competitive_intel_lookup` | `found`, `empty`, `error` | SerpAPI Google Ads search. |
| `crm.create_calendar_event` | 1 | Calendar insert. |

**Communication**

| ID | Outputs | Side effect |
|---|---|---|
| `comm.send_sms` | 1 | Telnyx SMS. |
| `comm.send_mms` | 1 | Telnyx MMS. |
| `comm.make_call` | `answered`, `no_answer`, `failed` | Vapi or TwiML. |
| `comm.send_voicemail` | 1 | Voicemail drop. |
| `comm.send_calendar_invite` | 1 | iCal invite over email. |

**AI**

| ID | Description |
|---|---|
| `ai.agent` | Autonomous loop with `tools[]`. |
| `ai.classify` | `text` → one of `categories[]`. |
| `ai.chat_response` | `prompt` + `history`. |
| `ai.voice_agent` | Vapi outbound voice agent. |
| `ai.transcribe` | Audio → text. |

**Integration**

| ID | Side effect |
|---|---|
| `integration.send_email` | SendGrid (or chosen provider). |
| `integration.send_fax` | SrFax / Telnyx. |
| `integration.send_esign` | E-sign packet via Workflow Settings provider. |
| `integration.http_request` | Generic HTTP w/ outbound URL guard. |

**Script** — every script node requires `approved: true` to execute.

| ID | Sandbox | Defaults |
|---|---|---|
| `script.javascript` | `node:vm`, no Node globals | `timeoutMs` default 5 000 ms |
| `script.python` | `child_process.spawn` | 15 000 ms |
| `script.bash` | `child_process.spawn` | 15 000 ms |

**IO**

| ID | Description |
|---|---|
| `io.sql_query` | Read-only (SELECT only) parameterized SQL. |

**Utility**

| ID | Outputs | Notes |
|---|---|---|
| `utility.log` | 1 | Levels: debug, info, warn, error. |
| `utility.end` | `__end__` | Terminal node. |

### 13.4 Vapi webhook events (public, signed)

Mounted under `/api/webhooks/vapi/*`:
- `POST /vapi` — generic.
- `POST /vapi/call-started`
- `POST /vapi/transcript`
- `POST /vapi/call-ended`
- `POST /vapi/intake-result`
- `POST /vapi/escalate-human`

Each hands off to the **Calls** page and propagates the qualification verdict onto the linked lead.

### 13.5 Per-category webhook receivers

Generic inbound message receivers exist at `/webhooks/{email,fax,sms,voice}/:provider` so every provider can post events back without firm-specific routing logic.

### 13.6 Common operational issues
| Symptom | Likely cause | Fix |
|---|---|---|
| Email send `403` "from address does not match a verified Sender Identity" | SendGrid Sender Identity not verified for the `from` address. | Verify the sender in SendGrid console, then set the verified email under Firm Settings. |
| `EADDRINUSE :::8080` on API server start | Two server processes booting simultaneously. | Restart workflows once and wait. |
| Workflow Settings dropdown is empty | No active integration in that category. | Add credentials in **Integrations** first; they'll appear in the picker. |
| Self-Heal stuck in `dispatched` | `JULES_API_KEY` missing or invalid. | Add `JULES_API_KEY` via Integrations. |
| Competitive Intel returns `serpapi_auth` | `SERPAPI_API_KEY` missing or revoked. | Re-add at Integrations / set the secret. |

### 13.7 Database tables (42 total) — high-signal ones

Full list managed by `lib/db/src/schema/`. The frequently-touched ones are:

`leads` (encrypted PII, see §7.2 columns) · `cases` (UUID PK, JSONB `data`, firm-scoped) · `documents` · `audit_log` · `paralegals` · `vendors` · `buyers` · `lead_sources` · `form_configurations` · `decision_engine_settings` · `users` (with `mfa_enabled`, `totp_secret`, `token_version`) · `firms` · `firm_invites` · `integrations` (firm-scoped) · `template_assignments` · `document_templates` · `document_envelopes` · `fax_results` · `automation_workflows` · `automation_runs` · `competitive_intel_advertisers` · `competitive_intel_snapshots` · `self_heal_sessions` · `api_keys` · `image_objects` · `processed_webhook_events` (idempotency ledger — see §13.11).

### 13.8 The full leads table schema

| Column | Type | Notes |
|---|---|---|
| `id` | `serial` PK | |
| `name` | `varchar(255)` | Normalized from first/last. |
| `email` | `varchar(255)` | Encrypted at rest (AAD = `email`). |
| `phone` | `text` | Encrypted at rest (AAD = `phone`). |
| `tort_type` | `varchar(100)` | Campaign slug. |
| `exposure_start` / `exposure_end` | `date` | Nullable. |
| `diagnosis_confirmed` | `boolean` | default false. |
| `diagnosis_type` | `varchar(255)` | Nullable. |
| `was_at_location` | `boolean` | default false. |
| `location_name` | `varchar(255)` | Nullable. |
| `status` | `varchar(20)` | default `new`. Enum below. |
| `rejection_reason` | `text` | Nullable. |
| `notes` | `text` | Nullable. |
| `ad_spend` | `decimal(10,2)` | Nullable. |
| `source` | `varchar(100)` | Nullable. |
| `assigned_to` | `integer` | FK → `paralegals.id`. |
| `routing` | `varchar(20)` | default `cold`. |
| `firm_id` | `integer` | Tenancy key. |
| `lookup_hash` | `text` | SHA-256 of `(tort_type|email|phone10)`. Used by dedup. |
| `convexity_score` | `varchar(20)` | `convex` / `neutral` / `concave`. |
| `convexity_action` | `varchar(20)` | `execute` / `modify` / `reject` / `review`. |
| `convexity_ruin_flags` | `jsonb` | default `[]`. |
| `created_at` / `updated_at` | `timestamp` | default `now()`. |

### 13.9 Status enums (exhaustive)

- **`leads.status`:** `new`, `qualified`, `signed`, `review_required`, `rejected`, `accepted`, `retained`.
- **`cases.status`:** `open`, `processing`, `analyzed`, `failed`, `documents_received`, `ready_for_review`, `client_signed`, `filed`, `review_required`, `closed`.
- **Qualification verdict:** `PASS`, `FAIL`, `REVIEW_REQUIRED`, `NOT_RUN`.
- **Convexity classification:** `convex`, `neutral`, `concave`.
- **Convexity action:** `execute`, `modify`, `reject`, `review`.
- **`fax_results.status`:** `pending`, `processing`, `done`, `error`.
- **`automation_runs.status`:** `running`, `completed`, `failed`.
- **`self_heal_sessions.status`:** `pending`, `dispatched`, `awaiting_approval`, `approved`, `rejected`.
- **Document envelope status:** `draft`, `sent`, `delivered`, `signed`, `declined`, `voided`.
- **Predictive `quality_tier`:** `platinum`, `gold`, `silver`, `bronze`, `unqualified`.

### 13.10 Audit-log action vocabulary

Emitted via `auditLog(entity_type, entity_id, action, details)`:

- **`lead`:** `created`, `updated`, `viewed`, `rejected`, `qualified`, `disqualified`, `note_added`.
- **`case`:** `intake_submitted`, `file_upload_queued`, `analysis_queued`, `status_updated`.
- **`paralegal`:** `create_paralegal`, `delete_paralegal`, `view_paralegal_performance`.
- **`import_batch`:** `import_batch_started`, `error_row_write_failed`.
- **`user`:** `role_changed`, `force_logout`.
- **`competitive_intel`:** `lookup`, `watchlist_add`, `watchlist_remove`, `watchlist_refresh` (only on ad-count delta).
- **`automation`:** `created`, `updated`, `enabled`, `disabled`, `executed`.
- **`document`:** `created`, `signed`, `redacted`, `deleted`.
- **General:** `export_leads`, `login_success`, `login_failed`.

### 13.11 Inbound webhook idempotency

Provider webhooks (Stripe, Telnyx, Vapi, Fasten, DocuSign, Dropbox Sign, generic email / SMS / fax / voice) are retried by the provider on any 5xx or timeout. Without dedup, a single physical delivery report would create N rows in `sms_messages` / `fax_events` / `email_events` and re-fire downstream automations.

The `processed_webhook_events` table is the dedup ledger. The helper `markWebhookProcessed({ provider, externalEventId, firmId, integrationId, eventType })` in `artifacts/api-server/src/lib/webhook-idempotency.ts` is called before state-mutating handlers and atomically claims the `(provider, external_event_id)` pair via a unique index. Losers of the race ack 200 to the provider and skip the mutation.

Failure mode: if the dedup write itself fails (DB blip), the helper fails **OPEN** — the event is processed normally — because dropping legitimate webhooks is worse than the occasional duplicate row during a DB outage.

Retention: nothing auto-prunes the ledger today. A nightly `DELETE WHERE first_seen_at < now() - interval '30 days'` is safe once the provider's longest retry window has expired (3 days for Stripe, less elsewhere).

### 13.12 Per-firm webhook URL variants

Provider webhooks arrive without a firm-id in the URL by default, which is fine in the single-firm shell but ambiguous in multi-firm deployments. Each channel-level route accepts BOTH shapes:

| Generic | Per-firm |
|---|---|
| `POST /api/webhooks/email/:provider` | `POST /api/webhooks/email/:provider/i/:integrationId` |
| `POST /api/webhooks/sms/:provider` | `POST /api/webhooks/sms/:provider/i/:integrationId` |
| `POST /api/webhooks/fax/:provider` | `POST /api/webhooks/fax/:provider/i/:integrationId` |
| `POST /api/webhooks/voice/:provider` | `POST /api/webhooks/voice/:provider/i/:integrationId` |

When the URL carries an explicit `:integrationId`, `loadProviderForWebhook` reads that row directly (with a refusal if the row's provider doesn't match the URL's `:provider`) — no cross-firm signature ambiguity. Operators in a multi-firm deployment should register the per-firm URL with each provider.

---

# Part III — Operating playbooks

These cheat sheets cover the most common end-to-end jobs.

### 14.1 "I just got a phone lead — get them into the system."
1. **New Intake** → fill every required field → Submit.
2. Lead row appears in **Leads** within seconds; the gatekeeper auto-runs.
3. Decision engine returns `convexity_action`:
   - `execute` → auto-assigned to a paralegal (round-robin §7.8). HIPAA + retainer auto-dispatched per **Assignment Matrix** (§8.4).
   - `review` → lands in **Review Queue** for human call.
   - `reject` → status becomes `rejected`, reason captured in `rejection_reason`.
4. Watch the **Job Queue** if you expect a fax / email / e-sign packet to fire.

### 14.2 "A document came in by fax — where does it go?"
1. **OCR Inbox** receives the fax; status `pending` → `processing` → `done` (or `error`).
2. Low-confidence fields → **Doc Review** for QA. You correct extracted values; bounding boxes show where each came from on the PDF.
3. On save, the document is attached to the matching case in **Documents** (vault SHA-256 hash recorded; original file is never overwritten).

### 14.3 "I want to alert myself when a competitor advertises for a new tort."
1. **Competitive Intel → Watchlist** → add the advertiser (e.g. "Morgan & Morgan").
2. **Automations** → new workflow:
   - Trigger: `trigger.schedule` with cron `0 6 * * *`.
   - Then: `crm.competitive_intel_lookup` for that watchlist entry.
   - On `found` branch: `comm.send_sms` to your phone with the `vars.advertiser_name + ' new ad'`.
3. Save and enable. Refresh-driven audit only fires when ad count changes (no spam).

### 14.4 "Why was this lead rejected?"
1. Open the lead from **Leads**.
2. Scroll to the Decision Engine trace at the bottom — every rule, pass/fail, AI verification output, plus `convexity_action` and `convexity_ruin_flags`.

### 14.5 "Onboard a new paralegal."
1. **Users → Invite** by email. They receive a verification link; cannot sign in until verified.
2. Once verified, set their role to **paralegal** (admin only). This bumps `token_version` if they had a prior session.
3. **Paralegals →** configure their `assigned_torts`, `licensed_states`, toggle Available **on**.

### 14.6 "Rotate an integration credential without downtime."
1. **Integrations** → open the integration card → **Edit credentials** → paste new key → **Test connection** → Save.
2. The old key is overwritten in place (encrypted with V2). No workflow restart required.
3. If you used `ENCRYPTION_KEY_V1` previously, V2 takes precedence on read; V1 is only consulted as a fallback during decrypt.

### 14.7 "Build an external automation against MTOS (n8n, Zapier, custom)."
1. **n8n / API Setup** → Create API key → choose scopes (`leads:read`, `automations:run`, etc.) → copy the `mtos_...` token (shown **once**).
2. Subscribe to events from `GET /api/admin/event-catalog/openapi.yaml`.
3. Verify webhook signatures with HMAC-SHA256 on the raw body using the secret you stored on creation.

### 14.8 "Force-logout a compromised user."
1. **Security** → find the user → **Revoke all tokens**. This bumps `users.token_version`. Every device they're on returns 401 on the next call.
2. Reset their password and re-enroll MFA before re-enabling.

---

# Part IV — Glossary

- **Audit log** — Immutable per-firm action history. Source of truth for "who did what, when."
- **Background Check Hub** — One-button fan-out across nine verification lanes (§11.7).
- **Bright lines** — Things AI never does unattended (§11.5).
- **Convexity** — Decision-engine framing of expected case value: `convex` (long right tail) > `neutral` > `concave` (capped upside).
- **DID** — A specific phone number (Direct Inward Dial) used for inbound call/SMS/fax routing.
- **Embed snippet** — `<script>` tag generated by Form Engine for placing on landing pages.
- **File Vault** — Append-only file store with SHA-256 hashing.
- **firm_id** — Tenancy key on every business table.
- **HMAC-SHA256** — Outbound webhook signature scheme used for buyer dispatch and event subscriptions.
- **Job Queue** — Postgres-backed async work queue consumed by the worker.
- **MDL** — Multi-District Litigation; many similar federal cases consolidated for pre-trial.
- **Permission** — Granular capability string (e.g. `automations:execute`).
- **Provider** — A third-party service for voice / SMS / email / fax / LLM / e-sign chosen in Workflow Settings.
- **Recursive retry** — AI Assistant's bounded retry loop with perspective shift + circuit breaker (§5.5).
- **Round-robin** — Lowest-load paralegal matching tort + state wins.
- **TCPA** — Telephone Consumer Protection Act. Consent text is snapshotted on every web form submission.
- **TrustedForm** — Third-party consent-capture certificate URL stored on the lead.
- **token_version (`tv`)** — Per-user counter for global JWT revocation.

---

*Document maintained at `docs/USER_MANUAL.md`. The version of this manual served inside the CRM at `/user-manual` is bundled at build time from `artifacts/mtos-crm/src/content/user-manual.md`. After editing, run `cp docs/USER_MANUAL.md artifacts/mtos-crm/src/content/user-manual.md` and rebuild.*
