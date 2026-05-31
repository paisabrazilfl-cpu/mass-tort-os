---
name: Git push / branch convention
description: How CRM pushes to GitHub must be named and structured — dated branch, full merge, no force.
---

# Git push / branch convention (owner standing rule)

- Every push → a **NEW branch**. Never force-push, reset, or rebase over `main`.
- Branch name = `YYYY-MM-DD` + short "what-changed" slug (e.g. `2026-05-31-automations-abby-planner-crm-read`). **No random/auto-generated names**, and not a bare date either.
- The branch must always be the **FULL latest CRM merged with zero loss of function** — every prior feature plus the new work.

**Why:** the platform owner set this rule on 2026-05-31 after a bare-date branch name (`05/31/2026`) was rejected as non-compliant. The intent is methodical, auditable history where each branch name documents the date + the change.

**How to apply:** when asked to push the CRM to GitHub, name the branch this way AND run it on a **task agent** — the main agent is hard-blocked from all git write ops (see git-push-blocked-on-main-agent.md). Also mirrored in replit.md "Git Push / Branch Convention".
