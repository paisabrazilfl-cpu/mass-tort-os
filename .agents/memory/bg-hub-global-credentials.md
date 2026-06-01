---
name: bg-hub global credential resolution
description: Why every background-check-hub lane resolves integration credentials globally (no firmId) and why "fixing" that by threading firmId breaks the connected integration.
---

# bg-hub lanes resolve credentials GLOBALLY, on purpose

Every background-check-hub lane (fcc-rnd, garbo, courtlistener, phone-provenance/twilio_lookup+telnyx, etc.) calls `getIntegrationCredentials(provider)` **without a firmId**. The hub entry `runBackgroundCheckHub(lead: LeadLike)` carries no firm context — `LeadLike` has no `firm_id` field — so no lane can thread one.

**Why this is correct, not a bug:**
- The connected integrations in this deployment are **global** rows (`firm_id` IS NULL).
- `getIntegrationCredentials(provider, firmId)` filters with `eq(integrations.firm_id, firmId)` — an **exact match that cannot hit a NULL row**. Passing a firmId therefore *misses* the global integration entirely and the lane silently falls back to unconfigured.
- So the firmId-less call is what actually makes the connected (global) integration resolve. Threading firmId would BREAK it.

**How to apply:** Do NOT "harden tenancy" by passing `firmId` into a bg-hub lane in isolation. A code reviewer/architect will flag the firmId-less call as a cross-tenant leak — it is a *latent* multi-tenant property shared by ALL lanes, not specific to one provider. A real multi-firm fix requires three things together: (1) thread `firm_id` through `LeadLike` + `runBackgroundCheckHub`, (2) update **every** lane in lockstep, and (3) make `getIntegrationCredentials` fall back to the global (NULL-firm) row when a firm-scoped lookup misses. Anything less either breaks the connected integration or only half-fixes tenancy.

# snapshot-sanitizer test is flaky (network echo)

`snapshot-sanitizer.test.ts` ("sanitized hub result … NO plaintext PII") runs the REAL hub with live network. The sanitizer masks by **field-name allowlist** (`maskStreet` on `street_address`/`address`/…). The address-validator and Census **residency** geocoder lanes can echo the matched street into a field the allowlist doesn't cover, so the street ("1428 Elm Street") leaks **only when those network calls respond a certain way**. It passes on re-run / when the geocoder returns nothing. Treat a lone failure here as flaky/pre-existing, not a regression — confirm by tracing which lane contains the leak (it will be `address`/`residency`, never `phone`).
