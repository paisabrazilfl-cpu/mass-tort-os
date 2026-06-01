---
name: Lead phone columns (phone vs phone_primary)
description: Leads store the phone number in two different fields depending on intake path; contact logic must read both.
---

# Lead phone columns

A lead's phone number can live in one of two encrypted fields depending on how
the lead was created: one path stores it under `phone`, the other under
`phone_primary`. `decryptLeadFields` exposes both.

**Rule:** any feature that contacts a lead by phone (SMS, voice) must resolve
`phone || phone_primary` — never just one — or leads from the other intake path
are silently unreachable.

**Why:** a dispatcher that read only `phone` enqueued messages for operator-intake
leads (which only have `phone_primary`) but then dropped them at send time with no
audit failure — a silent delivery gap that the welcome-SMS e2e exposed.

**How to apply:** mirror the same fallback at BOTH the enqueue gate AND the worker
send handler; an enqueue-side check alone still drops the job downstream. Pair the
send handler's terminal outcomes (no_phone / failure / success) with audit rows so
delivery is honestly recorded, not just enqueue intent.
