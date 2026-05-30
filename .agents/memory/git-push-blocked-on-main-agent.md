---
name: Git pushes need a task agent
description: Why GitHub push/fetch requests cannot be done by the main agent and how to route them.
---

The main agent in this workspace is hard-blocked from every git network
operation — not just `push`. Even a read-only `git fetch github` is refused
with: "Destructive git operations are not allowed in the main agent."

**Why:** Platform safety guard. There is no env var/flag to bypass it from the
main agent's environment.

**How to apply:** When the user asks to "push to GitHub" / sync the remote,
propose a background Project Task (project_tasks skill) and have it assigned to
a **task agent** (isolated environment), which CAN run git writes. If such a
task is assigned back to the main agent, it still cannot run — tell the user it
must go to a task agent. Note the GitHub remote in this repo is named `github`
(not `origin`); divergence checks must use `github/main`.
