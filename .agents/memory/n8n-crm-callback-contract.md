---
name: n8n → CRM callback contract gotchas
description: Two non-obvious rules for wiring n8n HTTP-node callbacks into CRM route schemas and for waking n8n at a specific pipeline stage.
---

## Rule 1 — CRM route schemas that receive n8n bodies must accept `.nullish()`, not just `.optional()`

n8n HTTP-Request nodes commonly render an absent field as JSON `null`, e.g.
`"npi": {{ JSON.stringify($json.npi ?? null) }}` emits `"npi": null` when the field
is undefined. A Zod schema of `z.string().min(1).optional()` accepts `undefined` but
**rejects `null`** → the callback 400s before any handler logic runs.

**How to apply:** any route consumed by an n8n (or other external orchestrator)
callback should declare optional provider/identifier fields as `.nullish()` and
normalize in the handler (`parsed.data.x ?? undefined`). Even better, keep the n8n
body minimal — send only the fields that carry real data and let the CRM source the
rest from stored records (we trimmed `/intake-completed` to send only `key_suffix`).

**Why:** this exact mismatch silently broke the intake→NPI orchestration step (n8n sent
`"npi": null`, route was `.optional()` only) and was only caught in code review, not by
typecheck or the unit tests.

## Rule 2 — to wake n8n at a specific pipeline STAGE, emit a dedicated post-commit outbound event

Subscribing the orchestrator to `lead.created` fires while the lead is still at the
earliest status (NEW/BG_CHECK_PENDING), so a downstream "only advance from STAGE X"
guard always skips and the automation never runs. Instead emit a dedicated CRM
outbound event (`pipeline.intake_sent`) **fire-and-forget after the transaction
commits** the target transition.

**How to apply:** in the state-machine, after `await db.transaction(...)` resolves,
gate on `result.applied && result.to === TARGET` then call the sync fire-and-forget
`dispatchEvent(...)` (it schedules on setImmediate and swallows its own errors, so it
can never roll back or fail the committed transition — do NOT `await`/`.catch` it).
Add the event to both the `CrmEventName` union and `EVENT_CATALOG`.
