---
name: Render mtos-api service config drift & API quirks
description: Two surprises managing the Render web service via the API — the tracked deploy branch silently drifted off main, and preDeployCommand is effectively un-clearable via the API.
---

# Render mtos-api service config drift & API quirks

Service: `mtos-api` = `srv-d8ea7h3bc2fs73ccsjvg`, owner `tea-d8a836beo5us739g6cc0`,
URL `https://mtos-api-2b4x.onrender.com`. Managed with `RENDER_API_KEY`.

## Tracked branch drifts off `main` — always verify before assuming a push deployed
- The blueprint and replit.md both say Render auto-deploys from `main`, but the
  live service had silently been retargeted to a **dated branch** (`2026-05-31-...`),
  so a push to `main` did **nothing**. Symptom: you push main, nothing deploys.
- **How to apply:** before/after any "push to main → it'll auto-deploy" assumption,
  GET the service and check `serviceDetails.branch`. Realign with
  `PATCH {"branch":"main"}` then POST a deploy. autoDeploy=yes does not help if the
  tracked branch is wrong.

## `preDeployCommand` is set-once via the API — you cannot change/clear it
- It lives under `serviceDetails.envSpecificDetails.preDeployCommand` (NOT top-level).
- You CAN set it when previously empty. You **cannot change or clear it afterward** —
  PATCHing `""`, `null`, `" "`, or any new command is silently ignored (build/start
  in the same object update fine; only preDeploy is frozen). Verified repeatedly.
- **Why this matters / landmine:** a one-shot destructive reset placed in
  preDeployCommand (DROP SCHEMA …) then becomes **permanent** and re-wipes+reseeds
  the DB on **every** deploy. Harmless while the DB is seed-only/pre-launch, but a
  data-loss bomb once real leads exist.
- **How to apply:** treat preDeployCommand as immutable from the agent side. If you
  must put a destructive one-shot there, the **owner must clear it in the Render
  dashboard** (Settings → Pre-Deploy Command → empty) before go-live. Prefer a
  self-guarding command (only act when sentinel absent) over an unconditional DROP,
  since you won't get to edit it later.
