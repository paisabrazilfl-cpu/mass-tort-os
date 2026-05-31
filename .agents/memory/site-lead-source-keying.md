---
name: SITES lead-source keying & rebuild verification
description: Why per-site lead counts/filters must key on web_form_<slug>, and why rebuild-all verifies a serviceable spine not the latest builder field set.
---

# Per-site lead counts and filters key on the stable source, not the tort label

A generated site's leads are written with `source = web_form_<slug>` (the
immutable slug, set by the web-form intake path). The tort *label* is
renameable and is NOT a stable key.

**Rule:** Any "leads for this site" count or filter (SITES list `lead_count`,
the "View leads" deep-link, the leads page banner) must key on
`web_form_<slug>` via the `source` filter — never on `tort_type == label`.
Pass the label only as a display string (`?label=`), keep `?source=` as the
real filter.

**Why:** Keying on the mutable label silently miscounts/misfilters the moment
an operator renames a tort; the slug never changes, so the source key is stable.

**How to apply:** Use the `siteLeadSource(slug)` helper for the key. The
`listLeads` API/OpenAPI exposes an exact `source` query param; the generated
client `ListLeadsParams` carries `source`.

# rebuild-all verifies a *serviceable* spine, not the latest canonical field set

`POST /api/sites/rebuild-all` iterates EVERY registry row, reloads each via
`getFormConfig` (lazy backfill), and verifies each resolves to an
operationally-usable intake page, returning `{scanned, rebuilt, verified,
failed, failures[]}`.

**Rule:** The verification bar is the *serviceable spine* — the four canonical
contact fields (`first_name`, `last_name`, `email`, `phone`), a `tcpa_consent`
field, and ≥1 eligibility rule. Do NOT verify against
`CANONICAL_BASE_FIELD_KEYS` (the latest comprehensive builder's full roster).

**Why:** Legitimately-seeded older sites use a different but fully serviceable
field roster. Checking the latest builder's full field set false-failed 30/35
live sites (e.g. paraquat, which renders fine) on the first implementation.
Empirically all seeded configs carry the serviceable-spine keys + ≥1 rule.

**How to apply:** When tightening this check, validate the new requirement
against the real DB roster first (`web_form_config->'fields'` keys across all
rows) before asserting presence, or you will flag working sites as broken.
