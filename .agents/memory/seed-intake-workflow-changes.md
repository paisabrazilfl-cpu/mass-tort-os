---
name: Seeded intake workflow changes
description: How to safely change the 3 seeded intake automation graphs, plus the owner decision to drop the in-pipeline consent gate.
---

# Seeded intake automation workflows

The three system-wide (firm_id = NULL) seeded intake pipelines (self_service / ai_agent / vendor)
are built in code and re-applied at API-server startup.

## Refresh / idempotency gotcha (how to ship a graph change)
- A seed row only auto-refreshes when it is **disabled AND unedited** (stored `seed_graph_sha`
  matches the live graph, or is a legacy null). **Enabled rows and operator-edited rows are
  never clobbered** — they keep their old graph forever.
- **Always bump `SEED_VERSION`** when you change any seed graph, otherwise nothing re-applies.
- **How to apply:** after editing, restart the api-server; verify with a DB query that the seeded
  rows show the new `trigger_config->>'seed_version'` and the expected node set.

## Decision: no in-pipeline consent/TCPA gate
- The `crm.consent_gate` node was **removed from all three seeded flows**; each flow's head now
  runs straight into the Background Check Hub. The node type still exists in the catalog/executor
  (usable in custom workflows) — it's just not in the seeds.
- **Why:** owner decision. Consent is established **upstream** before a lead ever reaches the
  pipeline — web-form TrustedForm certificate (self-service), recorded call + transcript (voice),
  vendor-supplied TrustedForm cert URL (vendor) — so re-gating inside the pipeline was redundant
  and could wrongly stall already-consented leads.
- **How to apply:** do not re-add an in-pipeline consent gate to the seeds without a new owner
  decision. The tradeoff is that consent enforcement now depends entirely on those upstream
  surfaces; if upstream enforcement is weakened, the seeds no longer backstop it.

## Decision: SMS-first claimant comms + Vapi voice confirmation
- **Every claimant-facing touchpoint in all three seeds is `comm.send_sms`** — acknowledgement,
  "documents ready to sign", e-sign reminder, and final confirmation. There are **zero
  `integration.send_email` nodes** in the seeds (the old ack/reminder/confirmation emails and the
  calendar-invite email were all replaced).
- **Why:** owner decision — claimants are contacted by text, not email.
- The **AI Agent (Voice)** flow additionally has a `ai.voice_agent` "Voice confirm details" node
  between NPI `verified` and the e-sign packet (e-sign starts from its `completed` handle;
  `failed` → review queue). The other two flows still start e-sign from NPI `verified`.
- **`ai.voice_agent` nodes leave `agentId` blank on purpose** so the template stays firm-agnostic;
  the executor resolves the lead's per-tort active Vapi assistant (`tort_voice_agents`) at runtime.
- **How to apply:** keep claimant comms on SMS unless the owner reverses this. When adding any new
  voice node to a shared/template workflow, leave `agentId` blank and rely on runtime resolution.
