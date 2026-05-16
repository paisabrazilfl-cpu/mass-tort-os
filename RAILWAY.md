# Deploying Mass Tort OS to Railway

One service per process. This guide bootstraps a production deployment on
Railway with two Railway services + one Postgres plugin, sharing a single
GitHub repo.

```
  ┌────────────────────────────┐   HTTPS (browser)   ┌─────────────────────────┐
  │   mtos-crm service         │ ◄────────────────── │   end users             │
  │   Vite SPA, vite preview   │                     └─────────────────────────┘
  └─────────────┬──────────────┘
                │ /api/* (fetch)
                ▼
  ┌────────────────────────────┐
  │   api-server service       │ ◄── webhook callbacks (Telnyx, DocuSign, etc.)
  │   Express, in-process      │
  │   worker via INPROC_WORKER │
  └─────────────┬──────────────┘
                │
                ▼
  ┌────────────────────────────┐
  │   Postgres plugin          │
  │   (provided by Railway)    │
  └────────────────────────────┘
```

## 1. Provision

In your Railway project:

1. **Add Postgres plugin.** `New → Database → Add PostgreSQL`. Railway sets
   `DATABASE_URL` automatically on any service you link it to.

2. **Create the `api-server` service.** `New → GitHub Repo → <this repo>`.
   In Service Settings:
   - **Root Directory:** `artifacts/api-server`
   - **Watch Paths:** `artifacts/api-server/**`, `lib/db/**`, `lib/api-zod/**`,
     `lib/integrations-anthropic-ai/**`, `lib/integrations-openai-ai-server/**`,
     `pnpm-lock.yaml`, `pnpm-workspace.yaml`
   - The build/start commands are read from `artifacts/api-server/railway.json`
     (already in the repo).

3. **Create the `mtos-crm` service.** `New → GitHub Repo → <same repo>`.
   In Service Settings:
   - **Root Directory:** `artifacts/mtos-crm`
   - **Watch Paths:** `artifacts/mtos-crm/**`, `lib/api-client-react/**`,
     `pnpm-lock.yaml`, `pnpm-workspace.yaml`
   - Commands are read from `artifacts/mtos-crm/railway.json`.

4. **Link Postgres → api-server.** On the api-server service: `Variables →
   Link Database → mtos-postgres`. This injects `DATABASE_URL`.

## 2. Required variables

Set these on the **api-server** service (`Variables` tab). See `.env.example`
for the full list with descriptions.

| Variable           | Value | Notes |
|--------------------|-------|-------|
| `NODE_ENV`         | `production`                           | Boot fail-closes otherwise |
| `DATABASE_URL`     | (auto-injected by Postgres plugin)     | |
| `SESSION_SECRET`   | `openssl rand -hex 32` output          | JWT signing |
| `ENCRYPTION_KEY_V1`| `openssl rand -base64 32` output       | Column encryption |
| `ANTHROPIC_API_KEY` or `OPENAI_API_KEY` | provider key                | At least one |

Set these on the **mtos-crm** service:

| Variable           | Value                                  |
|--------------------|----------------------------------------|
| `NODE_ENV`         | `production`                           |
| `BASE_PATH`        | `/`                                    |
| `VITE_API_BASE_URL`| `https://${api-server-railway-url}`   |

Get the api-server's public URL from the api-server service's `Settings → Networking → Public Networking` panel.

## 3. First-time DB bootstrap

The api-server runs idempotent `IF NOT EXISTS` schema repair on first
request (see `routes/automations.ts`, `routes/workflow-settings.ts`,
`routes/review-queue.ts`). For a fresh database that's enough — there is no
manual `migrate` step.

If you're migrating from an existing deploy, run the backfill scripts in
this order against `DATABASE_URL`:

```bash
psql "$DATABASE_URL" -f artifacts/api-server/src/scripts/backfill-automation-workflows-firm-id.sql
psql "$DATABASE_URL" -f artifacts/api-server/src/scripts/backfill-workflow-settings-firm-id.sql
psql "$DATABASE_URL" -f artifacts/api-server/src/scripts/backfill-review-queue-firm-id.sql
psql "$DATABASE_URL" -f scripts/backfill-cases-firm-id.sql
psql "$DATABASE_URL" -f scripts/backfill-integrations-firm-id.sql
psql "$DATABASE_URL" -f scripts/backfill-processed-webhook-events.sql
```

(Skip any that don't apply to your data.)

## 4. Verify

After both services go green:

```bash
# Health (no auth)
curl https://api.<project>.up.railway.app/health
# → { "status": "ok", ... }

# SPA loads
curl -I https://app.<project>.up.railway.app/
# → HTTP/2 200, Content-Type: text/html
```

Log into the SPA, run through one form submission → lead creation → review
queue, and confirm the operator can see only their firm's data.

## 5. Worker

The default behavior in `NODE_ENV=production` is that the api-server runs
the background job worker IN PROCESS (`INPROC_WORKER=1`). If you want a
dedicated worker service for capacity:

1. Add a third Railway service from the same repo.
2. Root Directory: `artifacts/api-server`.
3. Override the start command to: `node --enable-source-maps artifacts/api-server/dist/worker/worker.mjs`.
4. Set `INPROC_WORKER=0` on the original `api-server` service so it stops
   running the worker loop.
5. Link Postgres to the new service too.

## 6. Custom domains

For each service in Railway: `Settings → Networking → Public Networking → Add Custom Domain`.
Add a CNAME record at your DNS provider as Railway instructs. TLS is
auto-provisioned.

## 7. Things that DON'T apply on Railway

The repo still contains legacy files for other platforms — they're inert on
Railway but you can delete them at any time:

- `.replit` — Replit-specific config
- `replit.md`, `REPLIT_FIXED.txt` — Replit notes
- Any `wrangler.toml` / Cloudflare Pages workflow attempts

(This commit removes them.)
