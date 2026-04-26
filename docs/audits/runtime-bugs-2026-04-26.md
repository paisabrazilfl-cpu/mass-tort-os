# MTOS Runtime Bug Hunt — 2026-04-26

**Scope:** Task #5 of the exhaustive audit pass. Find latent runtime bugs in
the API surface, the workflow worker, the job queue, and the lead-import
pipeline. Fix each one in place. Out of scope: RBAC redesign (Task #10),
schema migrations, and any UI work in the CRM web app.

**Method:** Forensic log review → static crash-path scan (`parseInt`, raw
`sql\`DESC\``, untyped JSON) → handler-by-handler zod gap analysis → silent
`.catch(()=>{})` sweep → poison-pill replay against the worker → smoke
test of every endpoint touched.

---

## 1. Polluted job queue cleared

Four rows were occupying the worker's failure log without representing real
work that should ever be retried. They were deleted.

| id | job_type           | status        | reason                                      |
|----|--------------------|---------------|---------------------------------------------|
| 9  | `ingest_file`      | `failed`      | path-traversal probe (`case_id="../../../etc"`) |
| 10 | `ingest_file`      | `failed`      | same probe with base64 body                 |
| 17 | `create_case`      | `dead_letter` | `case_id: null` poison pill                 |
| 18 | `create_case`      | `dead_letter` | empty `{}` payload poison pill              |

Job 14 (`send_esign_packet`, `failed` — "no e-sign provider configured") was
**kept**. It documents a legitimate config gap the operator still needs to
resolve and is not noise.

After cleanup the queue holds 11 `done` and 1 `failed` rows.

---

## 2. Bugs found and fixed

Each entry below maps to one or more files in this commit. "Severity" is
the operator-impact rating, not a CVSS score.

### 2.1 `parseInt(req.params.id, 10)` returning `NaN` reached the DB — high
**Where:** `routes/paralegals.ts` GET `/:id` and `/:id/performance`.
**Symptom:** any non-numeric path segment (`/api/paralegals/foo`) produced
a `NaN` that drizzle silently sent to Postgres, which returned a generic
`invalid input syntax for type integer` 500 with no actionable code.
**Fix:** new `GetParalegalParams = z.object({ id: z.coerce.number().int().positive() })`
zod schema gates both routes and rejects with the standard
`{status:"error", code:"invalid_id", message}` envelope.

### 2.2 `sql\`DESC\`` template literal injection inside `orderBy` — medium
**Where:** `routes/leads.ts` lines 73–74, 148–149.
**Symptom:** `orderBy(sql\`DESC\`)` is not a valid drizzle order expression
— it relied on accidental SQL string concatenation. On Postgres 14 it threw
`syntax error at or near "DESC"` whenever an export crossed the
`EXPORT_HARD_CAP` boundary.
**Fix:** replaced with `desc(leadsTable.created_at)` and added `desc` to
the top-level `drizzle-orm` import.

### 2.3 `review_queue.details` rendered `[object Object]` for arrays — low
**Where:** `routes/review-queue.ts` line 35.
**Symptom:** when a conflict engine result wrote an array (vs. a plain
object) into `details`, the JSON serialiser blew past it and the CRM
rendered `[object Object]`.
**Fix:** guard the spread with
`typeof details === "object" && details !== null && !Array.isArray(details)`
and fall back to `{ raw: details }` otherwise.

### 2.4 No request-body validation on the case ingest path — high
**Where:** `routes/cases.ts` POST `/` and POST `/:id/files`.
**Symptom:** `file_name` was concatenated directly into the vault path,
allowing `..` traversal probes (jobs 9 and 10 above). Base64 `content`
had no size cap, so a single request could OOM the worker.
**Fix:** new `CreateCaseBody`, `UploadCaseFileParams`, and
`UploadCaseFileBody` zod schemas. `file_name` is now `regex(/^[A-Za-z0-9._-]+$/)`,
length-capped to 255, and rejects `..`. Base64 `content` is hard-capped
at 25 MiB (`MAX_CONTENT_BASE64_BYTES`).

### 2.5 No request-body validation on auth routes — high
**Where:** `routes/auth.ts` (login, register, refresh, change-password,
mfa-setup, mfa-verify, mfa-disable).
**Symptom:** missing-field crashes hit bcrypt with `undefined` and
returned a 500 instead of a 400, which the rate limiter then counted as
provider failures and tripped lockouts.
**Fix:** six inline `z.object` schemas and a shared `badRequest()` helper
that returns the unified envelope:
`{status:"error", code:"validation_failed", message, details}`.

### 2.6 Webhook HMAC verified against re-serialised body — high
**Where:** `routes/webhooks.ts` line 203 and `app.ts` body parser.
**Symptom:** `JSON.stringify(req.body)` reorders keys, normalises numeric
literals, and drops insignificant whitespace, so legitimate provider
webhooks (DocuSign, Twilio fax) failed signature verification at random.
**Fix:** the `express.json` middleware now captures the *exact* request
bytes via the `verify` hook, but **only** for `/api/webhooks/*` to avoid a
memory hit on every request. Webhook handlers HMAC against `req.rawBody`.

### 2.7 Worker swallowed non-retryable errors with `console.error` only — high
**Where:** `lib/workflow-handlers.ts` non-retryable branches.
**Symptom:** when a fax adapter returned a permanent failure code (bad
phone number, suspended account), the job was correctly dead-lettered but
no operator-visible signal existed.
**Fix:** non-retryable branches now emit both
`logger.error({...})` and an `audit_log` row with
`severity:"high"`, `lead_id`, `template_id`, and the provider failure
code so the admin Audit Log surfaces it.

### 2.8 Three silent `.catch(() => {})` swallowed real errors — medium
**Where:** `routes/leads.ts:271`, `routes/forms.ts:605`,
`routes/lead-import.ts:414`.
**Symptom:** failures in the review-queue backfill and the import
error-row insert vanished entirely. An operator saw "0 errors" on a batch
that actually had write failures.
**Fix:** every catch now `logger.warn({err, ...context})` with the lead
id / batch id so the failures show up in pino. The other
`.catch(()=>{})` instances in `leads.ts:281,320,536`, `forms.ts:588`
(scoring path) and `rbac.ts:90`, `ids.ts:182,186` (alert dispatch, which
already alerts on its own) were reviewed and intentionally left alone —
they sit on non-critical paths.

### 2.9 Inconsistent error envelope across the API — medium
**Where:** `app.ts` global error handler.
**Symptom:** the global handler returned `{error:"Internal server error"}`
while validation failures returned `{status, code, message, details}`. The
CRM client had two parsers and silently mis-routed 4xx as 5xx.
**Fix:** the global handler now returns the unified envelope. 4xx errors
preserve a thrown `code`/`message` if present; 5xx are deliberately
generic to avoid leaking SQL fragments or internal paths. A new
`/api/*` 404 handler keeps the API namespace JSON-only instead of
falling through to Express's default HTML 404 page.

### 2.10a `RangeError: Invalid time value` on bad date filter — high
**Where:** `routes/leads.ts` `buildLeadFilters()`.
**Symptom:** the OpenAPI-generated `ExportLeadsQueryParams` only validates
that `date_from` / `date_to` are *strings*, not valid ISO timestamps.
A request like `?date_from=garbage` produced `new Date("garbage")` →
Invalid Date → drizzle's `PgTimestamp.mapToDriverValue` threw inside
`Date.toISOString()` and the entire export / list query 500'd.
**Fix:** `buildLeadFilters` now throws a typed `BadDateFilterError` when
`Number.isNaN(d.getTime())`. Both call sites (GET `/api/leads/export`
and GET `/api/leads`) catch it and return a structured 400:
`{status:"error", code:"invalid_date_filter", message, details:{field,
value}}`. This matches the project-wide "malformed input → clean 400,
never silent fallback" policy. Smoke-tested:
- `GET /api/leads/export?date_from=garbage` → 400 envelope.
- `GET /api/leads?date_from=garbage` → 400 envelope.
- `GET /api/leads/export` (no filter) → 200 CSV.

### 2.10b `fax_results` lookup used a prefix-collision-prone `LIKE` pattern — medium
**Where:** `routes/leads.ts` GET `/:id/fax-results`.
**Symptom:** the original pattern `%_lead_${id}_%` matched
`med_records_request_lead_12_env_*.pdf` when the requesting lead id was
`1`, leaking other leads' fax results across the access boundary.
**Fix:** new `lib/fax-results-matcher.ts` centralises the
producer/consumer contract:
- `FAX_SOURCE_FILE_TEMPLATE(leadId, envelopeId)` — single source of
  truth used by `workflow-handlers.ts`.
- `buildFaxResultsLikePattern(leadId)` — emits the
  `med_records_request_lead_${id}_env_%` pattern, which is anchored on
  the literal `_env_` suffix so it can't bleed across ids.
- `parseFaxSourceFile(source)` — inverse used for diagnostics.
- 6 unit tests in `lib/__tests__/fax-results-matcher.test.ts` covering
  the prefix-collision case, non-positive ids, NaN, and round-tripping.

Tests run via `pnpm --filter @workspace/api-server run test`
(node:test + tsx, no new test framework added).

Producer side was also unified: `workflow-handlers.ts` now imports
`FAX_SOURCE_FILE_TEMPLATE` from the matcher module instead of inlining
the format string, so the producer/consumer contract has exactly one
source of truth.

### 2.11 5xx response in `routes/forms.ts` echoed `err.message` — high
**Where:** `routes/forms.ts` POST `/config/:tortId/fields` 500 branch.
**Symptom:** the catch block did `res.status(500).json({ error: msg })`
where `msg` was `err.message`. Drizzle and pg error messages routinely
include SQL fragments, table names, and sometimes raw values from the
failing query — i.e. PII or schema disclosure. The 409 "already exists"
branch was fine to surface.
**Fix:** the 500 path now returns the generic envelope
`{status:"error", code:"internal_error", message:"Failed to add custom
field"}` and logs the full error server-side via `logger.error`.

### 2.12 Lead-import error-row failure had no in-app signal — medium
**Where:** `routes/lead-import.ts:417` (the same catch as 2.8).
**Symptom:** even after the logger.warn was added in 2.8, the failure
was only visible in pino. A solo non-technical operator does not tail
the API console.
**Fix:** the catch now also writes a best-effort `audit_log` row with
`severity:"high"`, action `error_row_write_failed`, the row number,
the insert error, and the original import error — surfacing it in the
in-app Audit timeline. The audit insert is itself wrapped in a
try/catch so it can never abort the batch.

### 2.13a `routes/paralegals.ts` accepted malformed email and arbitrary role — high
**Where:** `routes/paralegals.ts` POST `/`.
**Symptom:** the OpenAPI-generated `CreateParalegalBody` only types
`email` as `string | null` and `role` as `string | null` — no email
format check, no role enum. The DB would happily store
`"email":"not-an-email"` and `"role":"<script>"`, leaking malformed PII
into downstream notification flows and breaking the role-based
filtering on the dashboard.
**Fix:** added a stricter handwritten `CreateParalegalSchema` in the
route file using `z.string().email().max(255).nullish()` for email and
`z.enum(["Paralegal","Senior Paralegal","Lead Paralegal","Intake
Specialist","Case Manager"])` for role. Bad payloads now 400 with
`details.fieldErrors` listing the offending fields. Verified:
- `{name:"Test", email:"not-an-email", role:"Paralegal"}` → 400
  `details.fieldErrors.email`.
- `{name:"Test", email:"a@b.com", role:"<script>"}` → 400
  `details.fieldErrors.role` listing the allowed enum.
- `{name:"Audit Test", email:"audit.test@example.com", role:"Senior
  Paralegal"}` → 201.
Also normalized two leftover `{error:"Not found"}` 404s in this same
file to the unified envelope.

### 2.13b `routes/forms.ts` end-to-end envelope normalization — high
**Where:** `routes/forms.ts` — every error response in the file.
**Symptom:** the architect code review flagged that forms.ts still had
~20 legacy `{error:"..."}` shapes plus pipeline-style responses
(`{status:"REJECTED", errors, action, pipeline, failed_step}` and
`{status:"ERROR", ...}`) on the `/submit` endpoint. The CRM had to
maintain two parsers and the pipeline `status` field collided with the
unified envelope's `status:"error"` discriminator.
**Fix:**
- Added `errorEnvelope` + `badRequest`/`notFound`/`conflict`/
  `unprocessable`/`serverError` helpers at the top of the file (same
  shape as the global handler in app.ts).
- Bulk-replaced all 19 `{error:"..."}` responses across the config,
  custom-fields, background-check, NPI, fraud, and FBI-escalation
  routes.
- The four pipeline responses on POST `/submit` (schema-validation
  reject, schema-validation crash, pre-tort reject, arbiter reject,
  CRM-storage crash) now carry the unified envelope keys
  (`status:"error"`, `code`, `message`) AND keep `pipeline`, `errors`,
  `failed_step`, `action`, plus a new lowercase `outcome:"rejected"|
  "error"` field replacing the previous uppercase `status:"REJECTED"|
  "ERROR"`. The intake page reads `pipeline`/`failed_step` to render
  which step failed; those fields are unchanged.
Verified:
- `GET /api/forms/config/nonexistent_tort` → 404 envelope.
- `POST /api/forms/submit {}` → 422 envelope with `outcome:"rejected"`,
  `failed_step:"SCHEMA_VALIDATION"`, full `pipeline[]` preserved.
- `POST /api/forms/background-check {}` → 400 envelope.
- `POST /api/forms/npi-verify {}` → 400 envelope.

### 2.13e Final stragglers in `routes/leads.ts` — medium
**Where:** `routes/leads.ts` POST `/` (hospital-fields and required-
fields 422 branches) and PATCH `/:id` (params + body parse failures).
**Symptom:** the third architect review flagged that two 422 pipeline
responses still used legacy keys (`status:"INVALID_LEAD"`,
`error_code:"..."`) and the PATCH route emitted bare
`{error: paramsParsed.error.message}` shapes.
**Fix:**
- Both 422 responses now emit `{status:"error", code, message,
  details:{missing_fields}}` while keeping the domain `action:"REJECT"`
  and `missing_fields` fields the intake page reads.
- PATCH `/:id` param + body parse failures now use the local
  `badRequest(res, error)` helper that returns the canonical envelope
  with `details:error.flatten()`.
Verified: `PATCH /api/leads/abc → 400 envelope`, `PATCH /api/leads/1
{name:12345} → 400 envelope with field-level details`.

### 2.13d Project-wide error-envelope sweep across all route files — medium
**Where:** every file in `artifacts/api-server/src/routes/`.
**Symptom:** the second architect review confirmed forms.ts/leads.ts/
paralegals.ts were normalized but pointed out that ~80 legacy
`{error:"..."}` shapes still existed across other route files
(analytics, auth, buyers, cases, decision-engine, document-templates,
documents, forms-public, image-objects, lead-import, lead-sources,
npi, ocr, review-queue, security, vendors, webhooks). The CRM client
still had to maintain two error parsers.
**Fix:**
- New `lib/http-errors.ts` exports a single envelope helper plus six
  named helpers (`badRequest`, `unauthorized`, `forbidden`, `notFound`,
  `conflict`, `unprocessable`, `serverError`).
- A one-shot mechanical rewrite (`.local/sweep-error-shapes.mjs`,
  conservative single-line regex) converted 82 legacy `res.status(N)
  .json({error:"..."})` calls across 18 files to the helpers, and
  added the imports automatically.
- 5 non-trivial cases were rewritten by hand: a 423 account-locked
  response in `auth.ts`, two 409 "name_taken" conflicts in `buyers.ts`
  and `lead-sources.ts` (now `conflict(res, "name_taken", ...)`), and
  two 502 NPI-Registry upstream errors in `npi.ts` (now
  `errorEnvelope(res, 502, "upstream_error", ...)`).
- `routes/leads.ts` had its own pre-existing local `badRequest` helper
  with a different signature (taking a ZodError); that one was renamed
  to import-alias `httpBadRequest` for the string-literal call sites
  while the local zod-flavored helper kept its name for the schema
  parse failures.
Net result: every error response across the API now matches the global
handler envelope, with the *exception* of the conflict-engine pipeline
shape and the form-submit pipeline shape which deliberately carry
extra domain fields (and whose `status` discriminator was already
fixed in 2.13b/c). 87 total responses normalized in this pass.
Verified the typecheck stays green and the unit tests still pass.

### 2.13c Legacy `{error: ...}` envelope across `routes/leads.ts` — medium
**Where:** 12 instances across `routes/leads.ts` (validation 400s,
"Lead not found" 404s, "Insufficient permissions" 403s, plus the
two conflict-engine pipeline responses at 422 and 409).
**Symptom:** the CRM client had to maintain two parsers — one for the
unified envelope used by auth/cases/paralegals/the global handler, and
one for the legacy `{error}` shape returned by leads. 4xx errors were
sometimes mis-rendered as 5xx.
**Fix:** added three small `badRequest` / `notFound` / `forbidden`
helpers at the top of `routes/leads.ts` and bulk-replaced every legacy
emit. The two pipeline responses at 422 (conflict reject) and 409
(review_required) keep their domain-specific `output_state` /
`conflict_type` fields — verified the CRM intake page reads those —
but now also carry the unified envelope keys (`status`, `code`,
`message`). The pre-existing `status: "review_required"` field on the
409 was renamed to `lead_status` to avoid colliding with the envelope's
`status: "error"` discriminator.

---

## 3. Other latent issues confirmed *not present*

Worth recording so the next audit doesn't re-investigate them:

- **'signed' status enum mismatch** — checked the workflow state-machine
  enum and the `lead_status` Postgres type; both already include `signed`.
  No change needed.
- **`forms-public.ts` NaN paths** — every `Number(...)` call is gated by
  `Number.isFinite` before use.
- **`scoring.ts` divide-by-zero** — denominators are guarded
  with `|| 1` in every code path.

---

## 4. Verification

- `pnpm --filter @workspace/api-server run typecheck` — clean.
- `pnpm --filter @workspace/api-server run test` — 6/6 pass.
- API server restarted; smoke tests against
  `https://$REPLIT_DEV_DOMAIN/api/...`:
  - `GET /api/leads/abc/fax-results` → `400 {code:"validation_failed"}`
  - `POST /api/auth/login {}` → `400 {code:"validation_failed", details:{...}}`
  - `POST /api/auth/refresh {"foo":"bar"}` → `400` with field-level details
  - `GET /api/this-route-does-not-exist` → `404 {code:"not_found"}`
  - `GET /api/leads/export?date_from=garbage` → `400` envelope
    (previously 500 — see 2.10a)
  - `GET /api/leads?date_from=garbage` → `400` envelope.
  - `GET /api/leads/export` → `200` with CSV.
  - `POST /api/paralegals {email:"not-an-email"}` → `400` with
    field-level details (see 2.13a).
  - `POST /api/paralegals {role:"<script>"}` → `400` listing the
    allowed enum.
  - `POST /api/paralegals` (valid) → `201`.
  - `POST /api/forms/submit {}` → `422` envelope with `outcome` +
    pipeline preserved (see 2.13b).
  - `GET /api/forms/config/nonexistent_tort` → `404` envelope.

Two architect code review passes identified seven follow-ups total
(2.10a, 2.11, 2.12, 2.13a, 2.13b, 2.13c, plus the producer/consumer
template-share noted in 2.10b) — all addressed in the same commit.

---

## 5. Follow-ups deferred to later tasks

- **Task #10 (RBAC redesign)** — `requireRole("viewer")` on
  `/api/leads/:id/fax-results` is correct for now but will be replaced
  with attribute-based access control covering the cross-firm case.
- **Worker observability** — the high-severity audit rows added in 2.7
  should be wired into a daily admin digest email. Outside this task's
  scope.
- **Job queue retention policy** — manual cleanup is fine for now (12
  total rows). When volume grows, add a nightly job that prunes `done`
  rows older than 30 days and surfaces `dead_letter` ones in the admin UI.
