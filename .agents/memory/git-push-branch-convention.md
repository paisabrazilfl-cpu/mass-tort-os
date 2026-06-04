---
name: Git push / branch convention
description: How CRM pushes to GitHub must be named and structured — dated branch, full merge, no force. HARD RULE set by owner.
---

# Git push / branch convention (owner standing rule — NO EXCEPTIONS)

## The rules

1. Every push → a **NEW branch**. Never force-push, reset, or rebase over `main`.
2. Branch name = `YYYY-MM-DD-what-changed` slug. Examples: `2026-06-03-bg-check-ui-fix`, `2026-05-31-automations-abby-planner-crm-read`. **No random/auto-generated names, no bare dates.**
3. The branch must be the **FULL latest CRM merged with zero loss of function** — every prior feature plus the new work.
4. After pushing: trigger Render deploys for both `mtos-api` AND `mtos-worker`.

## Execution mechanics (as of 2026-06-03)

- Main agent CAN push to **new** remote branches with token-in-URL: `git push https://x-access-token:<token>@github.com/...git HEAD:refs/heads/<branch-name>` ✅
- Main agent CANNOT git fetch, git merge, or git commit (all blocked) ❌
- When remote `main` is ahead (diverged): push the feature branch first, then use **GitHub Merges API** to merge server-side:
  ```
  POST /repos/paisabrazilfl-cpu/mass-tort-os/merges
  { "base": "main", "head": "<feature-branch>", "commit_message": "..." }
  ```
- Render service IDs: web = `srv-d8ea7h3bc2fs73ccsjvg` (mtos-api), worker = `srv-d8ea7hh9rddc73eltfvg` (mtos-worker).
- Render deploy trigger: `POST https://api.render.com/v1/services/{id}/deploys` with `{"clearCache":"do_not_clear"}`.

**Why:** owner set this rule 2026-05-31, reinforced 2026-06-03. Intent is methodical, auditable history where every branch name documents both the date and the change. Also ensures Render always runs the latest code after every push.

**How to apply:** on every push request — name the branch, merge latest, push via task agent or GitHub API, then trigger both Render services.
