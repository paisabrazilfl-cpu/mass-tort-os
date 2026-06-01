---
name: n8n outbound bridge (CRM → n8n)
description: How the CRM drives n8n via its official MCP server, the per-firm credential isolation, and the tenancy/honesty rules that govern it.
---

The CRM's automation engine can RUN n8n workflows (OUTBOUND, CRM → n8n). This complements the pre-existing INBOUND direction (n8n → CRM via minted `mtos_` API keys + outbound webhooks).

**Transport:** the user's live n8n Cloud exposes the official "n8n MCP Server" (Streamable HTTP / JSON-RPC) at `<tenant>.app.n8n.cloud/mcp-server/http`. It is STATELESS (no `mcp-session-id` threading required) but we still do the protocol-correct `initialize` → `notifications/initialized` → `tools/call` handshake. The bridge lives in `lib/automations/n8n-mcp.ts`; surfaced as catalog node `integration.n8n_execute` and routes under `/api/automations/n8n/*`.

**Per-firm credential isolation (the tenancy rule).** Every exported MCP fn takes an explicit `conn: McpConn` first arg; there is no implicit env read inside them. Connection selection is centralized in `selectN8nConn({firmId, envConn, firmConn})`:
- `firmId != null` (firm-scoped run) → use the firm's OWN vault connection (`firmConn`); **THROW if absent — NEVER fall back to the owner's env instance.** That fallback is the cross-tenant leak this whole change exists to prevent.
- `firmId == null` (system-scope: shared templates, scheduled platform jobs, the owner-only `/n8n/*` control plane) → use the global env connection (`envConn`); throw if absent.
- **Why:** the connected n8n account can list/run ANY workflow in it; a firm admin dropping a "Run n8n Workflow" node into a firm workflow must drive THEIR n8n, not the owner's.
- **How to apply:** firm conn is resolved by `getN8nConnForFirm(firmId)` in `routes/integrations.ts` — reads the firm's active `n8n` integration row, using the **plaintext `api_url` column as the MCP server URL** and the **encrypted `api_key` as the bearer token** (no schema migration, no new SECRET_FIELDS). The executor's `integration.n8n_execute` handler wires `s.ctx.firmId` through `selectN8nConn`.

**Env connection is system-scope ONLY.** `readEnvConn()` (was `readConn`) reads `N8N_MCP_URL`+`N8N_MCP_TOKEN`. `n8nConfigured()` reflects only that env pair. The `/n8n/status|workflows|execute` routes are still gated `requireRole("super_admin")` (owner-only control plane) and pass the env conn explicitly.

**Honesty invariant for the MCP client:** `parseResponse()` MUST throw on any body it can't turn into a JSON-RPC envelope (empty body, non-JSON/HTML 200, SSE with no `data:` frame, or an envelope with neither `result` nor `error`). Never return a `{raw:text}` fallback — callers only check `.error`, so a missing-but-not-errored `result` would be treated as clean success and a non-branch automation node would mark the step "ok". This is the general automation-executor failure-honesty rule applied to the transport layer.

**Prod note:** Render web + worker need `N8N_MCP_URL`/`N8N_MCP_TOKEN` for system-scope runs. For firm-scoped runs, the OWNER must add an n8n integration row for that firm under Integrations with `api_url` = MCP server URL and `api_key` = MCP access token. The n8n preset now lists `api_url` in its fields (form already renders it). Pre-existing webhook-only n8n rows (no `api_key`) will report `missing_required_secret` on `/:id/test` until re-saved with their token — acceptable.
