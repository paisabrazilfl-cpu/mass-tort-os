---
name: Vapi per-tort agent provisioning
description: Durable pitfalls when re-provisioning the per-tort Vapi voice agents (stale server bundle, self-inflicted rate limits, branding rule).
---

# Vapi per-tort agent provisioning

## Stale server bundle re-corrupts DB state
The api-server dev workflow runs a compiled bundle built at workflow start, not live source. Re-syncing via a one-off `tsx` script uses fixed source and succeeds, but the **running server keeps executing the old bundle** — so if the CRM UI hits a provisioning endpoint it recomputes fingerprints with the old template, decides everything is stale, re-pushes the old (buggy) payload, fails, and writes rows back to error, silently undoing the heal.
**How to apply:** after any change to voice-agent provisioning/prompt code, restart the api-server workflow before trusting the live system. Verify against DB status + a live Vapi GET, not just a script's return value.

## Don't self-rate-limit Vapi
Running provision-all repeatedly fires a burst of PATCH/POST calls and trips Vapi 429s (empty body — parsing it as JSON can also throw). Only out-of-sync rows make Vapi calls; in-sync rows are skipped.
**How to apply:** heal a batch by iterating the error rows one at a time with a few seconds of spacing and a couple of retry passes; wait ~60s after a 429 burst. Avoid back-to-back provision-all runs.

## Branding rule: MTOS, never a law firm
The product is NOT a law firm. Agent prompts/first messages must present MTOS as a claims intake / case-review service, disclaim legal representation and legal advice, and avoid positive firm/lawyer framing. A regression test enforces this.
**Why:** owner explicitly required generic/MTOS language with no law-firm framing.

## Vapi schema constraint
Vapi rejects inline custom-llm auth headers and caps assistant names; use native providers. A true custom LLM needs Vapi's credential flow, not inline auth.
