---
name: Intake consent canonicalization
description: How the public intake forms' legal consent text stays uniform and updates existing published forms without a DB migration.
---

The claimant consent shown on every public intake form is ONE canonical string
(`CLAIMANT_CONSENT_ACKNOWLEDGMENT` in `lib/consent-copy.ts`), keyed `tcpa_consent`.
It is a multi-clause legal block (TCPA + automated/AI contact, E-SIGN/UETA, perjury
attestation, 18+ adult capacity, indemnification, nationwide validity). `[COMPANY]`
is the system-wide brand placeholder (rendered literally).

**Rule:** to change the consent wording, edit only the constant. The three form
builders (`web-form-defaults.ts`, `comprehensive-tort-forms.ts`, `routes/forms.ts`)
import it for newly-built configs.

**Why render-time canonicalization:** already-published forms bake the label into
their stored `form_configurations.web_form_config` JSONB. `rebuildAllSites` is
verify-only and does NOT overwrite stored field labels, so changing the builders
alone would leave old forms on the old text. `withCanonicalConsent(fields)` is
therefore applied at READ/RENDER time on every surface that emits the fields — the
live embed (`generateWebFormEmbed`), the public config GET (`GET /api/web-forms/:tortId`),
and the SSR draft preview (`site-render.ts`) — so existing forms display the current
consent with no data migration. It force-overrides the `tcpa_consent` field to a
required checkbox with the canonical label (this intentionally clobbers per-campaign
customization of that one field — legal text must be uniform).

**How to apply:** any NEW surface that renders `cfg.fields` to a claimant must wrap
them in `withCanonicalConsent`, or it will show stale consent for old configs.
Submission validation keys on the `tcpa_consent` boolean + the `tcpa_required`
eligibility rule, NOT the label, so changing the text never affects enforcement.
