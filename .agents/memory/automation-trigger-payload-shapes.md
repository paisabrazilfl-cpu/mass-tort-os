---
name: Automation trigger payload shapes & leadId resolution
description: The three lead-entry triggers carry the lead id under different keys; gate handlers must resolve robustly across all shapes.
---

# Automation trigger payload shapes

The node-based automation engine dispatches three lead-entry triggers whose
input payloads carry the lead id under **different keys**:

- `trigger.lead_created` (vendor / API) → `input.lead.id` (lead object with id/name/email/phone/tort/state/status/source/tcpa_consent only — **no physician fields**)
- `trigger.form_submitted` (web self-service) → `input.lead.id` (lead object incl. hospital_fax)
- `trigger.inbound_call` (voice, vapi webhook) → flat `input.lead_id` (no lead object at all)

**Rule:** any handler that needs the lead id must resolve the configured param
first, then fall back to BOTH shapes:
`let id = Number(resolveOrLiteral(s, p.leadId)); if (!Number.isInteger(id)) id = Number(s.input?.lead_id ?? s.input?.lead?.id);`

**Why:** a naive `p.x ?? s.input?.lead_id ?? s.input?.lead?.id` short-circuits
on the *truthy template string* (e.g. `"input.lead.id"`) before it's resolved, so
the input fallbacks never fire and voice-flow runs throw "requires a resolvable
leadId" (or store the literal path string in audit rows). Resolve THEN fall back.

**How to apply:** when adding any node handler that reads the lead, or when
seeding/wiring graphs that run on more than one trigger type, do not assume
`input.lead.id`. Pull provider/physician fields by loading the lead row from the
DB (firm-scoped), not from the trigger payload — only `form_submitted`/`lead_created`
carry a lead object and neither carries physician fields.

## Firm scoping for automation gate handlers
Gate/DB handlers (`crm.consent_gate`, `crm.npi_lookup`, `documents.esign_all_signed`,
voice-evidence `call_logs` query) must firm-scope every lead/related lookup:
`s.ctx.firmId == null ? eq(id) : and(eq(id), eq(firm_id, s.ctx.firmId))`.
**Why:** seeded intake workflows are system-wide (`firm_id=null`) and dispatch
includes system workflows for firm events, so an unscoped raw-id lookup can read
cross-tenant rows. Mirror the pattern already in `crm.update_lead` /
`documents.send_dropbox_sign`.
