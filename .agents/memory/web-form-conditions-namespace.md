---
name: Web form show_if condition namespace
description: Why embed conditional visibility (show_if) resolves across two separate field structures, and the trap that looks like a bug but isn't.
---

# Embed `show_if` lives in web_form_config but resolves against custom_fields

A tort's intake form has **two parallel field structures** in `comprehensive-tort-forms.ts`:
- `web_form_config.fields` (built by `conf()` from per-tort eligibility/story arrays) — e.g. depo's duration field here is `depo_duration_use` (option "Less than 1 year").
- `custom_fields` (from `TORT_SPECIFIC_CUSTOM_FIELDS` + universal) — e.g. depo's duration field here is `depo_duration` (option "<1 yr").

**How conditional visibility actually flows (the non-obvious part):**
1. `FIELD_CONDITIONS` is derived ONLY from `web_form_config.fields[].show_if` (see `routes/forms-public.ts` `/embed/:tortId`). So a `show_if` MUST be declared on a `web_form_config` field, or `multi_step`/conditions never appear.
2. But the embed (`generateEmbedScript` in `routes/forms.ts`) RENDERS `custom_fields` (as `cf_<key>` inputs), not the web_form_config story fields.
3. At runtime `mtosFieldValue(key)` resolves a condition's source `field` by trying `[name="<key>"]` THEN `[name="cf_<key>"]`. So the `show_if.field` must name a **rendered custom field key**, not a web_form_config field key.

**Consequence / the trap:** depo's `show_if` is attached to web_form_config field `depo_total_injections` (correct — that's how it enters FIELD_CONDITIONS) but its `.field` points at `depo_duration` / value "<1 yr" — keys that exist in `custom_fields`, NOT in `web_form_config.fields`. This LOOKS like a dangling reference (a reviewer flagged it as a "critical bug"), but it is correct and functional: the embed renders `cf_depo_duration` (option "<1 yr") and the condition resolves against it. "Fixing" it to `depo_duration_use`/"Less than 1 year" would BREAK it, because that field is never rendered in the embed.

**Why:** FIELD_CONDITIONS derivation source (web_form_config) and the render source (custom_fields) are deliberately different layers; the condition is a cross-layer reference by key name.

**How to apply:** When adding/verifying a `show_if`: declare it on a `web_form_config` field (for FIELD_CONDITIONS), but make `show_if.field` + `value` match an actually-RENDERED field — i.e. a `custom_fields` key and its real option text. Verify empirically by fetching `/api/forms-public/embed/<tort>` and confirming both the condition's target key and source `field` (or its `cf_`-prefixed form) appear as rendered inputs with the expected option string. The intake SSR page (`/intake/:slug`) just loads the same `embed.js`, so there is no second conditional renderer to keep in sync.
