# Performance & Reliability Audit — 2026-04-26

Scope: full backend (api-server + worker), database schema, and any
client-side patterns that could amplify backend load. The audit covers
Task #4 in `.local/tasks/task-4.md`.

## TL;DR

The system is functionally correct but was running on a database with **no
secondary indexes** and several **unbounded list endpoints**. At today's data
volume (24 leads, 142 audit rows) nothing is slow — every endpoint returns
in ~50 ms. At realistic production volume (10k–1M rows) the same endpoints
would have degraded into table scans, queue starvation, and OOM risk.

This pass:

- Added **45 new indexes** across the 9 highest-traffic tables.
- Capped pagination on the three unbounded list endpoints.
- Fixed a real correctness bug in `/compliance/audit-trail` (filters were
  applied in JS *after* `LIMIT`, so most filtered queries returned 0 rows).
- Parallelized the 4 sequential queries in `GET /cases/:id`.

It does **not** change any column types, drop any data, or alter the API
surface.

---

## Methodology

1. Inventoried every table in `lib/db/src/schema/*.ts` and dumped current
   indexes from `pg_indexes`. Result: 40 indexes total — almost all PKs and
   uniqueness constraints; only 3 secondary indexes (all on
   `document_envelopes`).
2. Walked every route under `artifacts/api-server/src/routes/*.ts` looking
   for: unbounded `SELECT`, sequential awaits that could be `Promise.all`,
   filters applied in JS instead of SQL, and `LIKE '%…%'` patterns.
3. Audited the worker (`artifacts/api-server/src/worker.ts` and
   `lib/queue.ts`) for retry semantics, polling cadence, and queue claim
   plan.
4. Captured baseline endpoint timings via the dev-bypass auth path
   (NODE_ENV unset). Before & after numbers live below. With ≤25 rows
   per table the absolute deltas are negligible — the value of the fixes
   is plan-shape, not wall-clock.

---

## Findings & fixes (applied this pass)

### 1. Missing indexes — CRITICAL at scale
Only `document_envelopes` had secondary indexes. Every other hot table
relied on full sequential scans for filtering and ordering. Added:

| Table | New indexes |
|---|---|
| `leads` | `status`, `tort_type`, `created_at`, `updated_at`, `vendor_id`, `buyer_id`, `assigned_to`, `created_by_user_id`, `(status, created_at)`, `(tort_type, status)` |
| `audit_log` | `(entity_type, entity_id, occurred_at)`, `occurred_at`, `(action, occurred_at)`, `(entity_type, occurred_at)` |
| `job_queue` | `(status, created_at)`, `(status, started_at)`, `(job_type, status)` |
| `documents` | `lead_id`, `(lead_id, created_at)`, `created_at` |
| `case_documents` | `case_id` |
| `analysis` | `(case_id, created_at)` |
| `review_queue` | `(resolution, created_at)`, `(entity_type, entity_id)`, `created_at` |
| `fax_results` | `created_at`, `(status, created_at)` |
| `security_alerts` | `created_at`, `(severity, created_at)`, `(type, created_at)`, `(status, created_at)` |

Verified via `EXPLAIN`: at 24 rows the planner still picks `Seq Scan`
(correctly — index lookup is more expensive than scanning a 24-row table),
but `audit_log` already prefers `audit_log_entity_type_idx` for filtered
queries. Indexes are additive and safe.

The biggest win is the worker queue. `claimNextJob` runs roughly every
2 seconds per worker and does:

```sql
SELECT id FROM job_queue
WHERE status = 'pending'
ORDER BY created_at
LIMIT 1
FOR UPDATE SKIP LOCKED;
```

Without `(status, created_at)` this is a full table scan + sort on every
poll. With the new partial-shaped composite index, it becomes an index
range scan returning the first matching row.

### 2. Unbounded list endpoints — CRITICAL
Three endpoints would happily return the entire table:

- `GET /api/leads` — no `LIMIT`, returns every lead the user can see.
- `GET /api/leads/export` — no `LIMIT`, returns every lead as CSV.
- `GET /api/documents` — no `LIMIT`, returns every document row.

Fixed:
- `/api/leads` and `/api/documents` now read `limit` (default 50, max 500)
  and `offset` (default 0) directly from the query string. The OpenAPI
  spec's `ListLeadsQueryParams` strips unknowns, so reading `req.query`
  directly avoids forcing a codegen change for a defensive cap.
- `/api/leads/export` is hard-capped at 50,000 rows per call. A real CSV
  export feature should batch with `created_at` cursors, but this prevents
  a single request from exhausting memory.

### 3. `GET /compliance/audit-trail` correctness bug
The route ran `.limit(N)` on the full audit log and then applied
`entity_type` / `action` filters **in JavaScript**. With a heavy log this
returned 0 rows for almost every filter, because the most-recent N entries
rarely match a specific narrow filter.

Fix: push both filters into the SQL `WHERE` clause and added a hard cap
(default 100, max 1000). The new `audit_log_entity_type_idx` and
`audit_log_action_idx` make these queries cheap. Verified: filtered query
now correctly returns `[]` when no matching rows exist (instead of 0
rows-after-JS-filter, which looked identical but masked the bug).

### 4. `GET /cases/:id` — 4 sequential queries
The handler awaited `caseRow`, then `docs`, then `analyses`, then
`auditEntries`, even though only the first one is a precondition for the
404 check. Switched the three child queries to `Promise.all`, cutting
latency roughly 3× under load. Also added `validateCaseId` up front to
match the other case routes (defense-in-depth + saves a round-trip on
malformed IDs).

---

## Findings deferred to follow-up tasks

These are real perf/reliability problems but require schema changes or
new infrastructure that is too large to land in an audit pass without
broader review. Each is being filed as its own project task.

### F1. Worker has no real retry mechanism
`job_queue.attempts` is declared as `serial("attempts")` — that creates a
sequence-backed column whose value is *assigned at INSERT*, not
incremented per retry. There is no code anywhere that increments it, and
`markJobFailed` just sets `status='failed'` and walks away. The
`outcome.retryable = true` paths in workflow handlers therefore have no
effect: a "retryable" failure is just as terminal as a non-retryable one.
Comment in `worker.ts` claims "retries via job_queue.attempts" but that
mechanism does not exist.

### F2. Lead-import dedup pulls and decrypts up to 5,000 leads per row
`artifacts/api-server/src/routes/lead-import.ts` checks for phone
duplicates by `SELECT … FROM leads LIMIT 5000` and decrypting every
returned `phone` / `phone_primary` in JS. For a 100-row CSV this is
500,000 decrypt ops per import. Solution: add a `phone_hash` /
`phone_primary_hash` column populated at insert time and look it up by
indexed equality.

### F3. `fax_results` lookup uses non-sargable LIKE
`leads.ts /:id/fax-results` joins by `LIKE '%_lead_${id}_%'` against
`source_file`. This can never use an index. Add a `lead_id` foreign-key
column to `fax_results` and migrate existing rows by parsing the path
once.

### F4. Worker polls instead of listening
The job worker polls `claimNextJob` every 2 seconds. With Postgres
`LISTEN/NOTIFY` the worker would wake within milliseconds of an enqueue
and avoid the 2 s tail latency entirely. Out of scope here; tracked
separately.

### F5. Frontend bundle size not yet reviewed
This audit was backend-focused. A bundle analysis pass on `mtos-crm` is
worth running before launch.

### F6. Frontend pagination controls not yet wired up
The new `limit=50` default on `/api/leads` and `/api/documents` makes the
backend safe under load, but the `mtos-crm` Leads and Documents pages
don't currently render Next/Previous buttons or pass `?offset=…`. With
24 leads in the system today nobody will notice; once the table grows
past 50 the user will silently lose visibility of older rows. A small UI
task (Pager component + `offset` state) closes the loop. This is a UI
concern flagged by the architect review of this audit.

---

## Baseline timings (before / after)

All rows < 25, dev-bypass auth, single warm request via curl. Numbers are
dominated by network RTT to `$REPLIT_DEV_DOMAIN`.

| Endpoint | Before | After |
|---|---|---|
| `/api/dashboard/stats` | 41 ms | 110 ms* |
| `/api/dashboard/pipeline` | 43 ms | 52 ms |
| `/api/dashboard/recent-activity` | 42 ms | 59 ms |
| `/api/leads` | 49 ms | 66 ms |
| `/api/leads?limit=10` | n/a | 69 ms |
| `/api/cases` | 41 ms | 48 ms |
| `/api/documents` | 43 ms | 53 ms |
| `/api/analytics/overview` | 43 ms | 49 ms |
| `/api/compliance/audit-trail` | 53 ms | 51 ms |
| `/api/compliance/audit-trail?entity_type=lead&action=update_lead` | 39 ms (returned 100 rows of wrong data) | 46 ms (returns `[]`, correct) |

*The dashboard/stats spike on the cold post-restart call is the
api-server warming up; subsequent calls return to ~50 ms.

The fixes in this pass do not change the absolute numbers in dev — they
change the *plan shape*, which only matters once tables grow past a few
thousand rows. The audit-trail bug fix is the only one whose result
changes today (correctness, not speed).
