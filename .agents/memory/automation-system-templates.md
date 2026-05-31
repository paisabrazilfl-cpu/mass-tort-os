---
name: Automation system templates (firm_id NULL) sharing rule
description: Tenancy/secrecy rules for system-wide automation workflows shared across firms.
---

# Automation system templates & cross-tenant visibility

`automation_workflows` rows with `firm_id IS NULL` are **system-wide templates** shared to
every firm (e.g. the seeded intake→med-records pipelines). They are read-only to tenants; a
firm customizes one by **cloning** it into its own firm and editing the copy.

## Rules (and why)

- **Do NOT expose all null-firm rows.** Share a null-firm row cross-tenant only if it's
  explicitly published as a template (today: tagged `seed:intake-pipeline`).
  **Why:** a blanket "all null-firm rows" read leaks every internal/global row to every tenant
  with `automations:view`.

- **Never return a shared template's `trigger_config` to tenants** — redact it on detail reads
  AND blank it when cloning into a firm.
  **Why:** `trigger_config` can hold webhook paths/secrets/privileged config. The graph is the
  shareable part; the trigger is configured per-firm after cloning. Without blanking on clone, a
  tenant could clone a shared template and read the (unredacted, firm-owned) copy to exfiltrate
  the secret.

- **Writes stay strictly firm-scoped.** A tenant can read/clone/run a shared template but can
  never edit/delete the global row, and never sees another firm's runs for that shared ID.

## How to apply

When adding new shared templates, give them the publish tag and keep secrets out of (or expect
redaction of) `trigger_config`. When the read/clone/run surface changes, preserve these three
invariants: tag-gated visibility, trigger_config secrecy, firm-scoped writes/runs.
