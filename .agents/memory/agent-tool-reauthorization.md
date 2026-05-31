---
name: Agent/chat tool re-authorization
description: Why broad-gated AI agent endpoints must re-check each privileged tool action against the caller's real permissions and ownership scope.
---

# Re-authorize every privileged action an AI agent performs

A conversational/agent endpoint is typically gated by ONE broad permission
(e.g. Abby's `/api/ai-chat` requires only `DASHBOARD_VIEW`). When that agent
gains tools that read row-level data or write records, the endpoint-level
permission is NOT sufficient — each tool action must be re-authorized against
the caller's actual permissions, exactly as the equivalent UI route would.

**Why:** A code review failed this surface as broken access control: a viewer
could read leads/cases or create automation workflows *through the agent* that
they could never touch directly in the UI. The agent became a privilege-
escalation bypass.

**How to apply:**
- Map each agent tool/entity to the same permission the direct route enforces
  (leads→LEAD_VIEW_ANY/OWN, documents→DOCUMENTS_VIEW, forms→FORMS_CONFIG_VIEW,
  automation drafts→AUTOMATIONS_MANAGE, etc.). Use `hasPermission(user, perm)`.
- Enforce ownership scope: roles holding only a `*_VIEW_OWN` permission must be
  restricted to records `assigned_to` themselves — pass `userId` + an
  `ownScope` flag into the data helper and filter on it.
- Tables with no `firm_id` (cases/review/jobs here) cannot be firm-scoped at the
  row level — limit those to super_admin.
- Fail closed: if `ownScope` is requested but no caller id is present, deny
  rather than widening scope to the whole firm.
- On denial, return a polite in-chat note — do NOT 403 the whole conversation.
- Keep the data helper free of the RBAC import: compute the gate in the route,
  pass plain flags (isSuperAdmin/userId/ownScope) into the helper.
