---
name: n8n outbound bridge (CRM → n8n)
description: How the CRM drives the owner's n8n instance via its official MCP server, and the tenancy/honesty rules that govern it.
---

The CRM's automation engine can RUN n8n workflows (OUTBOUND, CRM → n8n). This complements the pre-existing INBOUND direction (n8n → CRM via minted `mtos_` API keys + outbound webhooks).

**Transport:** the user's live n8n Cloud exposes the official "n8n MCP Server" (Streamable HTTP / JSON-RPC) at `<tenant>.app.n8n.cloud/mcp-server/http`. It is STATELESS (no `mcp-session-id` threading required) but we still do the protocol-correct `initialize` → `notifications/initialized` → `tools/call` handshake. The bridge lives in `lib/automations/n8n-mcp.ts`; surfaced as catalog node `integration.n8n_execute` and routes under `/api/automations/n8n/*`.

**Connection is a SINGLE GLOBAL instance** configured via process env `N8N_MCP_URL` + `N8N_MCP_TOKEN`. There is NO per-firm n8n credential vault.
- **Why it matters:** the connected n8n account can list/run ANY workflow in it. Per-firm isolation does not exist for n8n.
- **How to apply:** the direct control-plane routes (`/n8n/status|workflows|execute`) are gated `requireRole("super_admin")` (owner only), NOT per-firm `AUTOMATIONS_*` perms — a firm admin must not drive the owner's n8n. RESIDUAL ACCEPTED RISK: the executor node `integration.n8n_execute` can still be placed in a firm-scoped workflow and reach the global n8n; the run context carries only `firmId` (no acting role; event-triggered runs have no user), so clean role-gating at execution isn't available. Building per-firm n8n creds is a larger change requiring owner approval — flag it, don't silently build.

**Honesty invariant for the MCP client:** `parseResponse()` MUST throw on any body it can't turn into a JSON-RPC envelope (empty body, non-JSON/HTML 200, SSE with no `data:` frame, or an envelope with neither `result` nor `error`). Never return a `{raw:text}` fallback — callers only check `.error`, so a missing-but-not-errored `result` would be treated as clean success and a non-branch automation node would mark the step "ok". This is the general automation-executor failure-honesty rule applied to the transport layer.

**Prod note:** Render web + worker services both need `N8N_MCP_URL` and `N8N_MCP_TOKEN` set or the bridge is inert there (dev env vars don't propagate to Render).
