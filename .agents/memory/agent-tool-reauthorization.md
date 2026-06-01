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

## Companion rule: automations executor lead/entity lookups are firm-scoped

**Rule:** every lookup of a lead (or other firm-owned row) inside
`lib/automations/executor.ts` node handlers MUST gate on `s.ctx.firmId` —
`firmId == null` is the system/global context (unscoped), otherwise
`and(eq(table.id, id), eq(table.firm_id, s.ctx.firmId))`. This is the same
convention every existing lead-touching handler already uses.

**Why:** a code review caught a new blank-`agentId` Vapi resolver that looked a
lead up by id with no firm predicate — a workflow running in firm A could
resolve (and dial on behalf of) a lead owned by firm B. Cross-tenant leak.

**How to apply:** when you add ANY new DB read of a firm-owned entity to an
executor handler or its helpers, thread `s.ctx.firmId` through and apply the
null-vs-scoped branch. Tables with no `firm_id` column can't be row-scoped —
restrict those to super_admin / system context instead of widening.

## Companion rule: lead-scoped routes outside leads.ts need their own ownership gate

**Rule:** `ensureLeadAccess` (the own-scope ownership check) is a private helper
inside `routes/leads.ts` — it is NOT shared. Any lead-scoped endpoint living in
another router (e.g. the background-check endpoints in `routes/forms.ts`) only
inherits its `requirePermission(...)` gate, which is a PERMISSION check, not an
OWNERSHIP check. Permission ≠ ownership: a role with `FORMS_BACKGROUND_CHECK`
plus only `LEAD_VIEW_OWN` could otherwise run/read a check against ANY lead id.

**Why:** a code review flagged this as an IDOR — a UI page that drives the lead
id from the URL (`/background-check?leadId=`) made it trivial to exercise. Fixed
by replicating the `canBypassOwnership` else `created_by_user_id`/`assigned_to`
check inline in each forms.ts bg-hub endpoint (run, hub-run, snapshots).

**How to apply:** whenever you add a `/.../lead/:id`-style route in any router
other than leads.ts, add the ownership check inline (load the lead's owner
columns, `canBypassOwnership(user)` short-circuit, else compare to `user.id`,
`denyForbidden` on mismatch). Don't assume the permission gate covers it.
