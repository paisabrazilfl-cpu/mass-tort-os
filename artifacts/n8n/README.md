# MTOS ⇄ n8n integration

This directory contains the day-one workflow JSON files plus operator
instructions for self-hosting n8n alongside MTOS. The CRM exposes:

- **Generic event dispatcher** — every active integration of `type=automation`
  receives every event listed in
  `integrations.config.userConfig.subscribed_events` (defaults to
  `["lead.created"]`). Payloads are signed with HMAC-SHA256 in the
  `X-MTOS-Signature` header.
- **API key auth** — long-lived bearer tokens with the `mtos_` prefix can be
  minted at `/api/admin/api-keys` (admin only). Tokens are scoped per
  resource (`leads:read`, `leads:write`, `cases:read`, …).
- **Event catalog** — `GET /api/admin/event-catalog` returns every event,
  payload shape, and the API surface that workflows call back into.

## Events emitted

| Event                | Source                         | Trigger                                      |
| -------------------- | ------------------------------ | -------------------------------------------- |
| `lead.created`       | `routes/leads.ts` POST         | Operator or web-form intake                  |
| `lead.updated`       | `routes/leads.ts` PATCH        | Any field mutated (`changed_fields` array)   |
| `ocr.completed`      | `worker.ts` after `process_fax`| Fax PDF OCR finishes (success or failure)    |
| `case.stage_changed` | `worker.ts` after `analyze_case`| `casesTable.status` changed                  |

## Workflow JSONs

| File                              | Subscribes to        | What it does                                                          |
| --------------------------------- | -------------------- | --------------------------------------------------------------------- |
| `01-lead-assign.json`             | `lead.created`       | Round-robins the new lead to the paralegal with the lowest open count |
| `02-npi-on-provider-fill.json`    | `lead.updated`       | Hits `/api/npi/search` whenever a `physician_*` field changes         |
| `03-ocr-routing.json`             | `ocr.completed`      | Low-confidence rows → review queue; clean rows → attach to lead       |
| `04-case-auto-advance.json`       | `case.stage_changed` | When a case transitions to `analyzed`, GET /cases/:id, count attached documents vs `MTOS_REQUIRED_DOC_COUNT` (default 3), and PATCH /cases/:id/status → `documents_received` if the threshold is met (and the case isn't already past it). |

## Self-hosting n8n

The recommended path on Replit Deployments is to run n8n as a sibling
service under `/n8n`:

```bash
npx -y n8n
# defaults to http://localhost:5678
```

Set the following env vars on the n8n side:

- `N8N_HOST=<your-mtos-domain>`
- `N8N_PATH=/n8n/`
- `WEBHOOK_URL=https://<your-mtos-domain>/n8n/`
- `MTOS_API_BASE=https://<your-mtos-domain>` (referenced by the workflow JSONs)
- HTTP Header Auth credential named **MTOS API Key** with header
  `Authorization: Bearer mtos_…` (token minted at `/api/admin/api-keys`).

Then, in MTOS:

1. Open **Integrations → Add automation**.
2. Paste the n8n webhook URL (one per workflow), e.g.
   `https://<your-mtos-domain>/n8n/webhook/mtos-lead-created`.
3. Tick the events to subscribe to (`lead.created`, `lead.updated`, etc.).
4. Optional: paste a shared secret in the API key field — the dispatcher
   will sign payloads with HMAC-SHA256 and n8n's webhook node can verify.

## Discovery — letting n8n see every CRM tool

n8n doesn't need to be told about each CRM endpoint by hand. Two
discovery surfaces are exposed:

### 1. OpenAPI spec (every API endpoint)

```
GET /api/admin/event-catalog/openapi.yaml
Authorization: Bearer mtos_…   (api_keys:manage scope)
```

In n8n: add an **HTTP Request** node, click **Import** → paste the URL
above (with the bearer header). n8n will generate one operation per CRM
endpoint automatically — leads, cases, paralegals, NPI lookup, OCR
results, review queue, automation runs, integrations, vault, every
admin endpoint, the lot. ~200 protected operations in total.

### 2. Internal node catalog (the 37 in-CRM workflow nodes)

```
GET /api/admin/event-catalog
Authorization: Bearer mtos_…   (api_keys:manage scope)
```

The response now includes `internal_automation.nodes[]` — a compact
description of every node available in the CRM's own visual workflow
editor (`/automations`). Each entry lists the node's type, label,
category, branch outputs, and parameter keys. Use this to map an
internal automation step to its HTTP equivalent — every CRM node is
just a wrapper around an internal service that's also reachable via
the OpenAPI surface.

The same data is rendered as a browsable, filterable table in the CRM
under `/automation-docs` (admin only) — alongside the events, payload
shapes, scopes, signing headers, and downloadable OpenAPI spec.

> **Deviation note:** a fully self-contained `artifacts/n8n` web artifact
> running n8n in this Repl is **not** included. The `n8n` npm package is
> ~1 GB installed and ships its own embedded SQLite DB / job queue;
> running it inside the same workflow surface as the CRM caused
> port-binding conflicts and dramatically increased deploy cold-start
> time. The supported pattern is to run n8n as its own deployable
> service — either `npx n8n` on a sibling Repl, n8n Cloud, or Docker —
> and point it at the CRM via the env vars above.
