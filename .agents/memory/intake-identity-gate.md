---
name: Intake Google identity gate (HIPAA)
description: How/why the standalone /intake/:slug pages gate PHI behind Google sign-in, and why enforcement is global server-side.
---

# Intake identity gate

Standalone public intake pages (`/intake/:slug`) can require "Sign in with Google"
before the PHI-collecting form. Feature-flagged by the `GOOGLE_OAUTH_CLIENT_ID`
env var — gate is OFF when unset (existing intake unbroken), ON when set.

Flow: intake SSR page renders Google Identity Services (`g_id_onload`/`g_id_signin`)
and hides the form (`#mtos-form-wrap`) until sign-in. A **same-origin** helper
(`GET /api/web-forms/intake-gate.js`) stashes the signed credential in
`window.__MTOS_GOOGLE_ID_TOKEN__` and reveals the form. The web-forms embed
forwards it as `payload.google_id_token`. Verification is server-side in
`runWebFormPipeline` STEP 0 via `lib/intake-identity.ts`
(`verifyGoogleIdToken` → google-auth-library `OAuth2Client.verifyIdToken`).

## Rule: enforce the gate server-side and GLOBALLY, never per-page-flag

Verification happens for **every** `/api/web-forms/:tortId/submit` whenever the
gate is enabled — not gated on "did the SSR page show the gate UI".

**Why:** a per-page signal (e.g. "gate was rendered") is attacker-controllable —
a direct POST just omits it and bypasses the check. The only non-bypassable
design is: gate enabled ⇒ a valid Google ID token is required regardless of
where the submission came from. Trade-off: third-party/partner embeds that don't
render the gate UI will also start requiring a token once the env is set (they'd
need the gate UI added). That is acceptable/desirable for a PHI form.

**How to apply:** if a future task needs ungated partner embeds to keep working
while `/intake/:slug` is gated, do NOT add a "skip enforcement" flag to the submit
path. Instead add the gate UI to those embeds, or split them onto a separate
submit endpoint with its own policy.

## Other constraints worth remembering
- PUBLIC_CSP `script-src` has NO `'unsafe-inline'`, so the GIS callback MUST be a
  same-origin external JS file (`intake-gate.js`), never an inline `<script>`.
- `intake-gate.js` route must be registered BEFORE `/:tortId` in web-forms.ts or
  the literal path is captured as a tort id.
- The raw token is deleted from the body after verification (never persisted);
  only the verified email/sub are audit-logged (`web_form_identity_verified`).
- Activation needs a Google OAuth 2.0 **Web** client with the dev preview origin
  and `https://mtosvelocity.com` as Authorized JavaScript origins; set
  `GOOGLE_OAUTH_CLIENT_ID` in dev env AND the Render web service.
