---
name: Automation executor failure honesty
description: When an automation node handler must throw vs return on failure, so runs are reported honestly.
---

# Automation executor failure-reporting invariant

The graph executor marks a step `status: "ok"` (and the run `completed`) **whenever a handler returns without throwing**. A handler reports an honest failure in exactly one of two ways:

1. If its node declares `outputs` (branches) in `node-catalog.ts`, return `{ __branch: "<failed-branch>", value: {...} }` so the graph routes around the failure. The executor validates the emitted branch against the catalog.
2. If its node has **no** declared output branches, it MUST `throw` on any operational failure (provider-not-configured, adapter-missing, downstream API non-ok, not-implemented). Returning `{ ok: false, ... }` from a non-branch handler is a **silent false-success**: the step shows green and the run shows `completed` even though nothing happened.

**Why:** this CRM is HIPAA/TCPA-adjacent and the AI Constitution forbids "inventing a clean result." A workflow that claims it sent a fax/voicemail/MMS or transcribed audio when the provider was off is a compliance and trust hazard — the operator reads the run list as truth.

**How to apply:** when adding or auditing a handler, check `node-catalog.ts` for an `outputs` field. No `outputs` ⇒ every failure path must throw, not `return {ok:false}`. The only legitimate `ok:false` returns in the executor are nested inside `{ __branch: "failed", value: { ok:false, ... } }`. A fast audit: `rg "ok:\s*false"` in the executor — every hit must be inside a `__branch` return.
