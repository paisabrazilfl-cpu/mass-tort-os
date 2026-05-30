---
name: Inbound voice call tenancy
description: How firm tenancy is resolved for inbound Vapi calls and why the dialed number is authoritative.
---

# Inbound Vapi call tenancy

For inbound voice calls, resolve the firm from the **dialed (destination) number**
mapping (`tort_phone_numbers.firm_id`), not just from `call.metadata.firm_id`.
Resolution priority: explicit `metadata.firm_id` → firm that owns the dialed
number. The number also resolves the tort (metadata → assistant → number).

**Why:** Inbound webhooks have no authenticated user. If firm is left null, the
lead dedup (`findExistingLeadForIntake`) runs a *global* search and can attach a
caller to another firm's lead (same tort+phone) — a cross-tenant leak. The
dedicated per-tort number is the only trustworthy tenancy signal on an inbound
call, so the firm it carries scopes the dedup/creation.

**How to apply:** Any new inbound-call path that creates/attaches a lead must
pass a firm scoped from the number mapping. The Vapi assistant record itself is
global (no firm column), so the assistant lane yields no firm — only the number
lane does.
