---
name: E-sign embedded signing via SMS link
description: How the claimant gets their e-sign link inside an SMS — embedded signing, the public /sign route that mints fresh provider URLs on demand, and why the SMS link must not depend on the initial send capturing a URL.
---

# E-sign embedded signing → SMS link

Claimants sign via a same-origin link `/sign/<token>` texted to them (SMS-only comms). The link
resolves to a freshly-minted provider signer URL at click time — it does NOT embed the provider
URL directly.

## The token
- Stateless JWT (HS256, signed with `SESSION_SECRET`, purpose `esign_sign`) carrying **only the
  leadId** — no PII, no envelope id. `/sign` looks up the lead's next pending envelope itself.
- Possession of the signed token is the only auth on the public route; cross-tenant safety comes
  from the token being unforgeable + the envelope lookup being scoped to that lead.

## The /sign route (public, markPublic)
- Verifies token → loads lead → finds next pending envelope (has external_envelope_id, non-terminal
  status, lowest id) → reads integration creds → `adapter.createSignerUrl()` mints a FRESH URL.
- DocuSign → 302 redirect; Dropbox Sign → same-origin wrapper page (hellosign-embedded SDK) with a
  **per-response nonce CSP** (PUBLIC_CSP has no `'unsafe-inline'`, so inline script needs the nonce).
- Every miss (bad token, no envelope, no adapter support) returns friendly degraded HTML, never a crash.

## Critical rule: when to include the link in the SMS
- The worker must include the `/sign/<token>` link whenever embedded signing is **resolvable at
  click time** — i.e. `typeof adapter.createSignerUrl === "function"` AND the envelope has an
  `externalEnvelopeId` — **NOT** merely when the initial `adapter.send()` happened to return a
  `signingUrl`.
- **Why:** `/sign` regenerates the URL on demand, so a transient null `signingUrl` on send must not
  silently drop the claimant's link (that would leave SMS-only claimants stranded with a
  "team will follow up" message and no way to sign). This was a real review finding.
- Only fall back to the honest "documents ready, team will follow up" SMS when the provider/adapter
  genuinely lacks embedded support. SMS-send failures are audited (sent/failed/skipped) and never
  thrown — the envelope is already sent and re-running the packet job risks duplicate dispatch.

## Wiring
- `notify_signer` boolean threads: node-catalog param → executor enqueue (3 send_esign sites) →
  queue.ts payload type → worker `handleSendEsignPacket`. Worker requests `embedded` mode when set.
- Adding the public `/sign` router required registering `"sign"` in BOTH allowlists in
  `rbac-route-matrix.test.ts` (the `expected` Set ~line 195 AND the ROUTER_PREFIX/
  ALLOWED_PUBLIC_PREFIXES block) — see [auth-only / public route lockstep notes].
