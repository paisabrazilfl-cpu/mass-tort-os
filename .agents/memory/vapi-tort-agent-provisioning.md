---
name: Vapi per-tort agent provisioning
description: Pitfalls when re-provisioning the per-tort Vapi voice agents (stale server bundle, self-inflicted rate limits, branding guard).
---

# Vapi per-tort agent provisioning

## Stale server bundle re-corrupts DB state
The api-server dev workflow runs a **compiled dist bundle built at workflow start**, not live source. Editing the provisioning/prompt logic and re-syncing via a `tsx` script works, but the **running server still executes the old bundle**. If the CRM UI then hits a provisioning endpoint (e.g. sync-out-of-date), the stale server recomputes fingerprints with the OLD template version, decides everything is out of date, PATCHes with the OLD buggy payload, fails, and writes rows back to `status="error"` — silently undoing the heal.
**How to apply:** after ANY change to voice-agent provisioning/prompt code, restart the `artifacts/api-server: API Server` workflow before considering the live system fixed. Trust DB status + a live Vapi GET, not just the script's return value.

## Don't self-rate-limit Vapi
Re-running provision-all repeatedly fires many PATCH/POST calls in a burst and trips Vapi `HTTP 429: {}` (empty body — calling `res.json()` on it can also throw). `provisionAllTortAgents` only calls Vapi for rows whose fingerprint/status is out of sync (active+matching = in_sync fast path, no call), so the burst size = number of error/stale rows.
**How to apply:** to heal a batch, loop the error rows calling `provisionTortAgent(id)` ONE at a time with ~3s spacing and a couple of retry passes; wait ~60s after a 429 burst before retrying. Avoid hammering provision-all back-to-back.

## Branding: MTOS, never a law firm
The product is NOT a law firm. Agent prompts/first-messages must present MTOS as a claims intake / case-review service, disclaim legal representation and legal advice, and never use positive firm/lawyer framing ("our firm", "your attorney"). A regression guard test locks this in and is registered in the rbac-test workflow.
**Why:** owner explicitly required generic/MTOS language, no law-firm framing.
**How to apply:** bump `TORT_AGENT_TEMPLATE_VERSION` whenever the shared prompt template changes so fingerprints shift and a re-provision actually re-pushes to Vapi.

## Vapi schema constraints (native providers only)
Vapi rejects inline `model.authorizationHeader` (custom-llm inline auth) and caps assistant `name` at 40 chars. Working assistants use native providers (e.g. `provider:"openai", model:"gpt-4o-mini"`). A custom LLM (e.g. BitDeer Qwen) would require Vapi's `POST /credential` + `credentialId`, not inline auth.
