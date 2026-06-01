---
name: Seeded intake workflow changes
description: How to safely change the seeded intake automation graphs; the 5-workflow intake→medical-records architecture; SMS-only + embedded-signing-link + no-consent-gate decisions.
---

# Seeded intake automation workflows

The system-wide (firm_id = NULL) seeded intake pipelines are built in code and re-applied at
API-server startup. As of the intake→medical-records refactor there are **5 seeded workflows**
keyed by stable string keys (3 reused + 2 added), not 3.

## Refresh / idempotency gotcha (how to ship a graph change)
- A seed row only auto-refreshes when it is **disabled AND unedited** (stored `seed_graph_sha`
  matches the live graph, or is a legacy null). **Enabled rows and operator-edited rows are
  never clobbered** — they keep their old graph forever.
- **Always bump `SEED_VERSION`** when you change any seed graph, otherwise nothing re-applies.
- **How to apply:** after editing, restart the api-server; verify with a DB query that the seeded
  rows show the new `trigger_config->>'seed_version'` and the expected node set.

## Architecture: 5-workflow intake → medical-records pipeline
The seeds are keyed (not positional); reuse a key to mutate a flow, add a key to add a flow.
- **self_service** → Intake Form → E-Sign. UNIFIED entry for ALL lead sources
  (trigger.form_submitted): validate → bg → extract provider → NPI → qualify → create case →
  render docs → send e-sign packet (embedded) → status pending_signature.
- **ai_agent** → Voice Lead Qualification (trigger.inbound_call): transcribe/summarize → ack SMS
  → bg → send intake-form-link SMS → status waiting_for_intake_form. NO NPI/e-sign — voice/vendor
  flows only qualify+hand off to the unified intake form.
- **vendor** → Vendor Lead Qualification (trigger.lead_created): cert presence → ack SMS → bg →
  send intake-form-link SMS → status waiting_for_intake_form. NO NPI/e-sign.
- **document_signed** (added) → Documents Signed → Fax & Route (trigger.document_signed):
  all-signed gate → fax HIPAA to provider → email retainer to ATTORNEY (internal) + store →
  status medical_records_requested.
- **inbound_fax** (added) → Inbound Medical Records Fax (trigger.inbound_fax): medical_extract →
  match to case → store → status medical_records_received → review queue.
- **Review branch at every gate**: each decision/qualify/fax/match node routes its failure handle
  to the review queue rather than dead-ending.

## Decision: no in-pipeline consent/TCPA gate
- The `crm.consent_gate` node was **removed from all seeded flows**. The node type still exists in
  the catalog/executor (usable in custom workflows) — it's just not in the seeds.
- **Why:** owner decision. Consent is established **upstream** before a lead reaches the pipeline
  (web-form TrustedForm cert, recorded call + transcript, vendor-supplied cert URL), so re-gating
  inside was redundant and could wrongly stall already-consented leads.
- **How to apply:** do not re-add an in-pipeline consent gate without a new owner decision. The
  tradeoff is consent enforcement now depends entirely on those upstream surfaces.

## Decision: SMS-only claimant comms, signing link INSIDE the SMS
- **Every claimant-facing touchpoint is SMS** (`comm.send_sms`). There are **zero claimant-facing
  email nodes**. Internal/attorney email (e.g. retainer copy to the attorney) IS allowed.
- **Why:** owner decision — claimants are contacted by text, not email.
- The e-sign packet uses **embedded signing**: the worker requests an embedded signer URL and texts
  the claimant a same-origin link `/sign/<token>`. See [esign-embedded-signing-sms](esign-embedded-signing-sms.md).
- **How to apply:** keep claimant comms on SMS unless the owner reverses this. Any new
  claimant-facing notification in a seed must be SMS, never email.
