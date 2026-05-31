---
name: Production host reality (Railway vs Render)
description: Where mtosvelocity.com actually runs vs the intended Render target, and the remaining owner-only go-live steps.
---

# Production host reality

- As of 2026-05-31, live `mtosvelocity.com` is served by **Railway** (response headers `server: railway-edge`, `x-railway-edge`). The owner says this is an OLD deployment to **disregard**.
- The **intended** production target is **Render**, but **no Render service exists yet**. The `RENDER_API_KEY` values seen so far authenticate to accounts holding only unrelated apps; none deploys `mass-tort-os` or serves `mtosvelocity.com`.
- `RAILWAY_TOKEN` authenticates as the owner (paisabrazilfl@gmail.com) but lists no personal projects — the prod project is under a team/workspace.

## `.render/render.yaml` is now tracked on `main` (was the hidden blocker)
- The Blueprint file was previously **gitignored** (`.gitignore` had a bare `.render/`), so it had **never been committed to any branch**. A Render Blueprint reads `render.yaml` from the connected repo, so this silently blocked the whole go-live. Fixed by narrowing the ignore to `.render/*` + `!.render/render.yaml` and committing it. **Do not re-add `.render/` to gitignore** — the Blueprint must stay tracked. It holds no secret values (all `sync:false`).
- The full latest CRM + the Blueprint is now on `github/main` (and on branch `2026-05-31-render-blueprint-go-live`).

## Remaining go-live steps are OWNER-ONLY (not doable from an agent env)
These need the Render dashboard (browser/OAuth) and the actual secret values, which an agent does not have:
1. **Create the Render Blueprint**: Render dashboard → New → Blueprint → connect the `paisabrazilfl-cpu/mass-tort-os` repo via GitHub OAuth → it reads `.render/render.yaml` from `main` and creates `mtos-db`, `mtos-api` (health `/api/healthz`), `mtos-worker`.
2. **Set `sync:false` secrets manually** on BOTH `mtos-api` and `mtos-worker`: `SESSION_SECRET`, `ENCRYPTION_KEY_V1`, `ENCRYPTION_KEY_V2`. Plus `VAPI_PUBLIC_KEY` (and optionally `VAPI_API_KEY`) on the web service. Without these the app won't start / can't decrypt ePHI.
3. **Point DNS** for `mtosvelocity.com` at the Render web service.
4. **Verify** `https://mtosvelocity.com/api/healthz` returns 200 from Render (not the Railway edge).

**Why:** replit.md's Deployment section reads "deployed on Render", which is still aspirational until the owner does steps 1–4 above.

## Pushing to `main`: it can diverge — merge, never force
- On 2026-05-31, `github/main` had **6 commits not in local main** (already-merged Vapi/competitive-intel work + deletion of the legacy `deploy-railway.yml`), while local had 20. A force-push would have destroyed the 6. Reconciled with a **merge commit** (clean: only overlap was a both-deleted file; merged tree was byte-identical to local, so zero functional change), making the push a fast-forward. Always merge to preserve work; never force/reset over `main`.
