---
name: Dev vs prod database are separate
description: The Replit workspace DATABASE_URL is a dev DB, NOT the Render production DB — matters for any "fix prod data" request.
---

# Dev DB (Replit) is NOT the production DB (Render)

The workspace `DATABASE_URL` points at the Replit-managed dev Postgres (host
`helium`). Production (mtosvelocity.com) runs on Render's `mtos-db`, a separate
database this environment cannot reach for writes.

**Why it matters:** when asked to "resolve" data-level issues (dead-letter jobs,
security alerts, stuck rows, lead cleanup), changes made here against
`DATABASE_URL` only affect the dev environment. They do NOT change what
production serves. State this up front and scope each fix as dev-only unless it
acts on a shared external service.

**How to apply:**
- Data fixes via `psql "$DATABASE_URL"` = dev only.
- Code fixes reach prod only via a GitHub `main` push (which the main agent is
  blocked from — needs a task agent) → Render auto-deploy.
- Exceptions that DO affect prod from here: anything mutating a shared external
  service (e.g. healing Vapi voice assistants updates the real Vapi account, not
  just the local DB row).
- To inspect prod data, use the database skill in production read-only mode.
