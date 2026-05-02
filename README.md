# Mass Tort OS

Commercial CRM platform for mass tort law firms — lead intake, eligibility decisioning, document automation, telephony, and billing.

## Stack

- **Frontend:** React + Vite SPA (`artifacts/mtos-crm`)
- **API:** Express + Drizzle ORM, esbuild-bundled (`artifacts/api-server`)
- **Worker:** Background job processor (same package, separate entrypoint)
- **Database:** PostgreSQL 16
- **Monorepo:** pnpm workspaces

## Deploy (Render Blueprint)

This repo includes a `render.yaml` Blueprint that provisions:

- `mtos-db` — PostgreSQL 16
- `mtos-api` — web service (serves API + SPA bundle, health check at `/api/healthz`)
- `mtos-worker` — background worker for queued jobs

To deploy:

1. Push to `main` (auto-deploys via Blueprint)
2. Set the following secrets in the Render dashboard for both `mtos-api` and `mtos-worker`:
   - `SESSION_SECRET`
   - `ENCRYPTION_KEY_V1`
   - `ENCRYPTION_KEY_V2`
3. Run database migrations once after first deploy (see `lib/db/`)

## Local development

This project lives in a Replit workspace with managed workflows; use the Replit UI to start services.
