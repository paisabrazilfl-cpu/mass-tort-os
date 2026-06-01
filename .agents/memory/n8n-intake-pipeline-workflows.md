---
name: n8n intake-pipeline workflows (CRM-orchestration rebuild)
description: How the 6 intake automation templates were rebuilt as REAL n8n workflows that call the CRM API, and the non-obvious constraints that shaped them.
---

The CRM's intake automation templates were rebuilt as standalone n8n Cloud workflows (paisabrazil.app.n8n.cloud) using "n8n orchestrates → CRM executes": each n8n workflow is a Webhook trigger + HTTP Request nodes that call the CRM API for every regulated action, authenticated with a minted `mtos_` key.

**Auth model that makes this work (verified in `lib/rbac.ts` + `lib/api-keys.ts`):**
- An `mtos_` bearer authenticates AS the user in `api_keys.created_by_user_id` — adopting that user's **role + firm**. So a key minted under the super_admin owner (firm 1) satisfies every `requirePermission`.
- `checkScope` runs on top; a `["*"]` scope row bypasses scope entirely. Mint directly via DB insert into **`api_keys`** (NOT `mtos_api_keys`): `key_hash = sha256_hex("mtos_"+randomBytes(48).base64url)`, `key_prefix`, `firm_id` & `created_by_user_id` both NOT NULL, `scopes text[]`.

**The trigger gap (IMPORTANT, non-obvious):** the CRM outbound event-dispatcher only emits **`lead.created`, `lead.updated`, `ocr.completed`, `case.stage_changed`**. The templates' literal triggers (`inbound_call`, `document_signed`, `inbound_fax`, `form_submitted`) are INTERNAL automation triggers, NOT outbound webhook events. So to actually fire the n8n workflows you must either map to an available event (Stage1 vendor/voice ← `lead.created` filtered by source; Stage2 ← `lead.created`/`lead.updated`; Stage3 ← `lead.updated`/`case.stage_changed` status=signed; Stage4 ← `ocr.completed`) OR add new emissions to the CRM event-dispatcher (code change → task agent).

**Regulated-action mapping (no direct endpoints by design — n8n flips state, CRM sends):**
- E-sign packet = `POST /api/leads/:id/qualify` (or PATCH status→`qualified`) → CRM's `enqueueLeadApprovalPackets` does the actual send.
- Medical-records fax = CRM auto-fires on `document.signed` internally; there is NO API to send a fax, so Stage 3's n8n only does note/status/routing.
- Other actions DO have endpoints: SMS `POST /api/leads/:id/send-sms {body}`; background-check `POST /api/forms/background-check-hub/lead/:id {}`; status `PATCH /api/leads/:id {status}`; note `PATCH /api/leads/:id/notes {notes}` (**OVERWRITES** the notes field — no append endpoint); review `POST /api/review-queue {entity_type,entity_id,reason}`.
- `PATCH /api/leads/:id` status is **free-text** (no enum). Real values in use: new, web_form_intake, qualified, rejected, review_required, signed.

**n8n build via the bridge (`lib/automations/n8n-mcp.ts`, bash only, env `N8N_MCP_URL`/`N8N_MCP_TOKEN`):**
- Tool `get_sdk_reference` returns the full `@n8n/workflow-sdk` doc. Pattern: `workflow(slug,title).add(trigger).to(node)...`; `ifElse().onTrue().onFalse()` for branching; `newCredential('name')`, `expr('{{...}}')`. Node versions: webhook 2.1, httpRequest 4.4, set 3.4.
- `validate_workflow({code})` then `create_workflow_from_code({code})`; create makes an **inactive draft** (good).
- **The bridge CANNOT create n8n credentials — only list/use.** `create_workflow_from_code` auto-assigns a vault credential ONLY if a matching-type credential already exists (else `autoAssignedCredentials: []` and the HTTP nodes are unassigned). So `httpHeaderAuth` nodes need the OWNER to create a Header Auth credential (header `Authorization` = `Bearer mtos_<key>`) and assign it — that's the unavoidable "add the key & turn it on" handoff.
- Drafts don't expose a live webhook URL until `publish_workflow`; publishing a Webhook trigger does NOT auto-fire (unlike Schedule). Safe live test = self-address a TEST lead (owner's own phone/email) like the welcome-email proof.
