---
name: Intake pipeline bootstrap surfaces
description: Which public intake endpoints actually start the Intake-to-Med-Recs pipeline state machine, and which silently don't.
---

# Intake-to-Med-Recs pipeline: which intake surface bootstraps it

The pipeline state machine (`leads.pipeline_status` + `pipeline_events`) is only
entered by `startLeadPipeline` (NEW → BG_CHECK_PENDING). That call lives in the
**shared `runSubmissionPipeline`** handler, which is fronted by:
- `POST /api/forms/submit` (auth, operator CRM intake)
- `POST /api/forms-public/submit/:tortId` (anonymous third-party embed / embed.js)

It is **NOT** called by `POST /api/web-forms/:tortId/submit` — the standalone
public intake pages served at `/intake/:slug` (routes/web-forms.ts →
`runWebFormPipeline`). Leads created via that surface get a row but never enter
the state machine.

**Why this matters:** a transition attempted on a lead whose `pipeline_status`
is NULL is *illegal-from-null* — `transitionLead` still writes a `pipeline_events`
row (audit) with `applied=false, outcome='illegal'` and does NOT change the
column. So a webhook/control-route can return a 200 with a full-looking event
trail while `pipeline_status` stays NULL and nothing actually advanced. If you
see a complete-looking `pipeline_events` trail but `applied=f` on every row and a
NULL `pipeline_status`, the lead was never bootstrapped.

**How to apply:** to drive a lead through the pipeline, enter via
`/api/forms-public/submit/:tortId` (bootstraps), OR call `startLeadPipeline`
directly. `startLeadPipeline` is fire-and-forget after submit returns — poll
`GET /api/pipeline/leads/:id/status` for `BG_CHECK_PENDING` before posting the
bg-check webhook.

**Schema contract (forms-public / shared pipeline):** every config field is
server-required. Standard fields are bare keys; custom fields submit as
`cf_<key>`; checkbox fields (`diagnosis_confirmed`, `was_at_location`, checkbox
customs) must be `true`/`"true"`/`"on"`. Needs `tcpa_consent` + a well-formed
`trustedform_cert_url`. (The `/api/web-forms` path uses a *different*, looser
required-field set and an extra `contact_preference` ∈ {agent, text_email} gate.)

**Open finding:** if `/intake/:slug` standalone pages are an intended claimant
entry point, their not bootstrapping the pipeline is a real gap to close (wire
`startLeadPipeline` into `runWebFormPipeline` too). Reported, not fixed.
