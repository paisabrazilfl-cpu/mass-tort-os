---
name: Production host reality (Railway vs Render)
description: Where mtosvelocity.com actually runs vs the intended Render target — don't assume a Render prod exists.
---

# Production host reality

- As of 2026-05-31, live `mtosvelocity.com` is served by **Railway** (response headers `server: railway-edge`, `x-railway-edge`). The owner says this is an OLD deployment to **disregard**.
- The **intended** production target is **Render**, but **no Render service exists yet**. Both `RENDER_API_KEY` values seen so far authenticate to accounts holding only unrelated apps (neurobuddy, psyche-hub, Nova-, my-legal-system, motion-scanner-v3); none deploys `mass-tort-os` or serves `mtosvelocity.com`.
- `RAILWAY_TOKEN` authenticates as the owner (paisabrazilfl@gmail.com) but lists no personal projects — the prod project is under a team/workspace.

**Why:** replit.md's Deployment section reads "deployed on Render / mtosvelocity.com", which is currently aspirational, not factual. Believing it cost time hunting for a Render service that doesn't exist.

**How to apply:** before "deploy to Render", remember the Render service must be **created from `.render/render.yaml`** (Blueprint → connect the `mass-tort-os` repo via GitHub OAuth in the Render dashboard, then set the `sync:false` secrets). Don't assume an existing Render prod, and don't treat the Railway site as the target.
