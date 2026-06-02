# Intake-to-Med-Recs Automation Pipeline — Evidence Report

**Task:** #168 — MTOS Intake-to-Med-Recs Automation Pipeline
**Date:** 2026-06-02
**Reporting standard:** evidence-based. Every claim below points at a file, a test, or a
command output produced during this build. Blockers are disclosed in §6, not hidden.

---

## 1. What was built

A deterministic, event-driven state machine that drives a claimant from first intake
through to medical records received, persisted to Postgres with a full audit trail and
fed by idempotent inbound webhooks. It reuses the CRM's existing live adapters (NPI/NPPES
lookup, background-check hub, e-sign dispatch, HIPAA fax) rather than reimplementing them.

### State graph (17 states)
Defined in `artifacts/api-server/src/lib/pipeline/state-machine.ts` (`PipelineStatus`):

```
NEW → BG_CHECK_PENDING → BG_CHECK_CLEAR → INTAKE_SENT → INTAKE_COMPLETED
    → NPI_PENDING → NPI_VERIFIED → DOCS_SENT → DOCS_SIGNED
    → {HIPAA_FAXED, RETAINER_DISTRIBUTED}  (order-independent fan-out)
    → AWAITING_MED_RECS → MED_RECS_RECEIVED → COMPLETE
```
Rejection / hold branches: `BG_CHECK_PENDING → BG_CHECK_FAILED → REJECTED`, and
`NPI_PENDING → NPI_HOLD → REJECTED`. `COMPLETE` and `REJECTED` are terminal.

Transitions are whitelisted in `LEGAL_TRANSITIONS`; any edge not in the map is rejected.

---

## 2. Components and where they live

| Concern | File |
| --- | --- |
| State graph + `transitionLead` (tx, idempotency, illegal logging) | `artifacts/api-server/src/lib/pipeline/state-machine.ts` |
| Stage orchestration (bg verdict, NPI, docs-signed fan-out, med-recs) | `artifacts/api-server/src/lib/pipeline/pipeline.ts` |
| Adapter seams over live NPI / bg-hub impls (env-selectable) | `artifacts/api-server/src/lib/pipeline/adapters.ts` |
| Schema: `leads.pipeline_status` + `pipeline_events` table | `lib/db/drizzle/0001_pipeline_events.sql` (replayed by `apply-schema.mjs`) |
| Inbound webhooks: bgcheck, inbound-fax; e-sign signed hook | `artifacts/api-server/src/routes/webhooks.ts` |
| Operator/n8n control router (`/api/pipeline/...`) | `artifacts/api-server/src/routes/pipeline.ts` |
| Worker job handler `run_bg_check` | `artifacts/api-server/src/worker.ts` |
| n8n orchestration | `artifacts/n8n/workflows/05-intake-to-medrecs.json` |
| Unit + DB tests | `…/lib/__tests__/pipeline-state-machine.test.ts`, `…/pipeline-orchestration.test.ts` |

---

## 3. Idempotency & audit (the core correctness guarantees)

- Every transition writes a row to `pipeline_events` (from/to status, trigger, outcome,
  `event_key`, payload, source, actor).
- `event_key` is a unique claim. A replay of the same event (same vendor event id / job id)
  is detected and suppressed as a **duplicate no-op** — no second advance, no duplicate row
  with the claimed key.
- An **illegal** transition does NOT change `leads.pipeline_status`, and logs a row with
  `applied=false`, `outcome='illegal'`, and `event_key=null` (the key is deliberately not
  claimed, so a later legal event can still use it).
- Webhooks are fail-closed on signature: bgcheck requires `BGCHECK_WEBHOOK_SECRET`
  and inbound-fax requires `INBOUND_FAX_WEBHOOK_SECRET` (no secret ⇒ 503; bad HMAC ⇒ 401),
  both verifying an HMAC-SHA256 over the raw body and using `markWebhookProcessed` for
  transport-level replay suppression in addition to the state-machine's `event_key`.
  A public endpoint that mutates pipeline state never advances on an unauthenticated call.

---

## 4. Verification performed (commands + results)

All run on 2026-06-02 against the workspace (dev) database.

| Check | Command | Result |
| --- | --- | --- |
| Type safety | `pnpm --filter @workspace/api-server run typecheck` | **clean** (tsc -b libs + noEmit) |
| State-machine tests | `node --test pipeline-state-machine.test.ts` | **10/10 pass** (pure graph + DB tx/idempotency/illegal/unknown-lead) |
| Orchestration tests | `node --test pipeline-orchestration.test.ts` | **5/5 pass** (CLEAR trail, idempotent replay, FAILED→REJECTED trail, REVIEW parks, inbound-fax→COMPLETE + replay) |
| RBAC route gates | `rbac-test` workflow | **finished green** (boot-time route validator + perm-gate suites) |
| Route protection matrix | `bash scripts/check-rbac-route-matrix.sh` | **OK** — 333 rows; headline `332 checked / 50 public / 282 protected / 0 unprotected` |
| Schema drift | `db-drift` workflow | **OK** — 58 tables in sync (only pre-existing orphans `conversations`, `messages`, unrelated to this work) |
| Worker handler | worker workflow restart | `run_bg_check` now processed (was "Unknown job type" on the stale build before restart) |

### Test trails proven (orchestration test assertions)
- **Happy path (CLEAR):** applied trail = `[NEW, BG_CHECK_PENDING, BG_CHECK_CLEAR, INTAKE_SENT]`, final status `INTAKE_SENT`.
- **Replay:** second CLEAR with same `keySuffix` → every transition `outcome='duplicate'`, applied trail unchanged.
- **Rejection (FAILED):** applied trail = `[NEW, BG_CHECK_PENDING, BG_CHECK_FAILED, REJECTED]`, final status `REJECTED`.
- **REVIEW verdict:** zero transitions, lead parked at `BG_CHECK_PENDING` for an operator.
- **Inbound med-recs:** `AWAITING_MED_RECS → MED_RECS_RECEIVED → COMPLETE`; a duplicate inbound fax adds no applied events.

---

## 5. n8n orchestration

`artifacts/n8n/workflows/05-intake-to-medrecs.json` sequences the stages by calling the
CRM control endpoints (it orchestrates; the CRM remains the deterministic executor):
`lead.created` webhook → extract fields → `GET /api/pipeline/leads/:id/status` →
guard "only advance from INTAKE_SENT" → `POST …/intake-completed` (runs live NPI) →
branch on NPI verified vs hold. Authenticated with an MTOS API key scoped to
`automations:view,execute`. The bgcheck and inbound-fax legs are driven by the
idempotent webhooks rather than n8n polling.

---

## 6. Honest blockers & known limitations

These are real and not worked around silently:

1. **No live third-party vendor credentials in this environment.** There are no live
   DocuSign or external background-check-vendor keys wired here. The bgcheck webhook,
   e-sign signed hook, and inbound-fax correlation are implemented and unit/DB-tested,
   but an **end-to-end run against a real vendor was not performed** because the
   credentials do not exist in dev. The in-repo background-check **hub** path (worker
   `run_bg_check`) is exercisable and was verified to be picked up by the worker.

2. **`DOCS_SIGNED` advances per-signed-envelope, not gated on all-three-signed.** The
   e-sign hook (`applyEnvelopeEvent` signed-block) calls `applyDocumentsSigned` when an
   envelope is signed. The task description envisioned an "all-three-signed → DOCS_SIGNED"
   gate. The current implementation advances on the signed envelope and is idempotent per
   envelope (`keySuffix=env<id>`), but does **not** yet count distinct required envelopes
   before advancing. If the retainer/HIPAA/authorization are three separate envelopes,
   a follow-up is needed to require all three before `DOCS_SIGNED`.

3. **Inbound-fax correlation depends on a cover-sheet / sender mapping.** Correlation is:
   explicit `lead:<id>` reference first, else an **unambiguous** sender-fax match against
   `AWAITING_MED_RECS` leads' `hospital_fax`. An uncorrelated or ambiguous fax is
   acked (HTTP 200) and logged rather than guessed — deliberately, to avoid attaching PHI
   to the wrong claimant. Reliable correlation in production needs a cover-sheet token or
   a dedicated inbound DID per matter. **Security:** the endpoint is fail-closed and
   requires `INBOUND_FAX_WEBHOOK_SECRET` to be set in dev AND the Render web/worker env —
   without it the route returns 503 and never advances a lead.

4. **Full 21-file `rbac-test` suite could not be run in a single bash invocation** (the
   sandbox killed the combined process on resource limits). It was instead verified via
   the **`rbac-test` workflow** (finished green) and a 135-test subset run directly
   (all pass). The route-matrix and headline checks pass independently.

5. **Schema applied to the DEV database only.** `drizzle-kit generate` is broken in this
   repo; the migration `0001_pipeline_events.sql` was hand-authored and applied to dev,
   and is replayed on fresh DBs by `apply-schema.mjs` (split on `--> statement-breakpoint`).
   **Production (Render) picks it up on next deploy/runtime schema apply** — it has not
   been applied to prod from here (prod is owner-deployed via GitHub `main`).

---

## 7. Summary

The deterministic pipeline, its audit trail, idempotency guarantees, inbound webhooks,
control router, worker handler, and n8n orchestration are implemented and pass all
type, RBAC, drift, and behavioral tests available in this environment. The honest gaps
are the absence of live vendor credentials for a true end-to-end run, the per-envelope
(vs all-three) `DOCS_SIGNED` gate, and production-correlation hardening for inbound fax —
all enumerated above for follow-up.
