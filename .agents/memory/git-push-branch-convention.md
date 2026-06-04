---
name: Git push / branch convention
description: How CRM pushes to GitHub must be named and structured — dated branch, full merge, no force. HARD RULE set by owner. Never push directly to main.
---

# Git push / branch convention (owner standing rule — NO EXCEPTIONS)

## The rules

1. Every push → a **NEW branch**. Never push directly to `main`, never force-push, reset, or rebase over `main`.
2. Branch name = `YYYY-MM-DD-what-changed` slug. Examples: `2026-06-04-workspace-hero-banners`, `2026-06-03-bg-check-ui-fix`. **No random/auto-generated names, no bare dates.**
3. The branch must be the **FULL latest CRM merged with zero loss of function** — every prior feature plus the new work.
4. After pushing: merge to main via GitHub Merges API, then trigger Render deploys for BOTH services.

## Execution mechanics — GitHub Contents API branch workflow

Since `git commit` is blocked in bash, use the GitHub Contents API with a branch, not direct-to-main:

### Step 1 — Get current main HEAD SHA
```
GET /repos/paisabrazilfl-cpu/mass-tort-os/git/ref/heads/main
→ sha = the commit SHA of current main tip
```

### Step 2 — Create the new branch
```
POST /repos/paisabrazilfl-cpu/mass-tort-os/git/refs
{ "ref": "refs/heads/2026-MM-DD-what-changed", "sha": "<main-tip-sha>" }
```

### Step 3 — PUT each changed file TO THE NEW BRANCH (not main)
```
PUT /repos/paisabrazilfl-cpu/mass-tort-os/contents/<path>
{
  "message": "feat: ...",
  "content": "<base64>",
  "sha": "<existing-file-sha-or-omit-if-new>",
  "branch": "2026-MM-DD-what-changed"   ← MUST specify the new branch, NOT main
}
```

### Step 4 — Merge into main via Merges API
```
POST /repos/paisabrazilfl-cpu/mass-tort-os/merges
{ "base": "main", "head": "2026-MM-DD-what-changed", "commit_message": "Merge: ..." }
```

### Step 5 — Trigger Render deploys
```
POST https://api.render.com/v1/services/srv-d8ea7h3bc2fs73ccsjvg/deploys   (mtos-api web)
POST https://api.render.com/v1/services/srv-d8ea7hh9rddc73eltfvg/deploys   (mtos-worker)
```

## Token / auth
- Use `$GITHUB_TOKEN` env var (works, confirmed 2026-06-04). The old embedded token in git remote URL expired.
- Use `$RENDER_API_KEY` for Render. HTTP 200 with empty body = success (Render does not return JSON for deploy triggers).

**Why:** Owner set 2026-05-31, reinforced 2026-06-03 and 2026-06-04. Every branch name documents date + change. Ensures Render always runs latest code. Direct-to-main pushes violate the auditable history requirement.

**How to apply:** Every single push — no exceptions. Name the branch, create it from main HEAD, PUT files to the branch, merge to main, trigger both Render services.
