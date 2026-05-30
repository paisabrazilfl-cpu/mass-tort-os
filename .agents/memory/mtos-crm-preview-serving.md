---
name: MTOS CRM preview serving (static bundle)
description: Why register/SPA screenshots can show stale UI, and how to make the preview reflect web changes.
---

# MTOS CRM preview is served from a prebuilt static bundle

Both the `api-server` artifact (paths `/api` and `/`) and the `mtos-crm` web artifact (path `/`) register on `/`. The api-server serves the CRM SPA from `artifacts/mtos-crm/dist/public` (see app.ts "Serving CRM SPA static bundle"). The `screenshot` tool hitting `localhost:80/<path>` lands on the api-server, which returns the **prebuilt static bundle**, NOT the live Vite dev server (port 24540).

**Consequence:** after editing any `mtos-crm` source file, screenshots/preview can show STALE UI until `dist/public` is rebuilt — even though Vite HMR updated the live dev server.

**How to apply:** to make the preview reflect web changes, rebuild the SPA from bash:
`BASE_PATH=/ PORT=24540 pnpm --filter @workspace/mtos-crm run build`
(Vite outDir is `dist/public`; the api-server serves that directory directly, so no copy step is needed.) Then re-screenshot. `pnpm --filter @workspace/mtos-crm run typecheck` remains the canonical correctness check regardless of the served bundle.
