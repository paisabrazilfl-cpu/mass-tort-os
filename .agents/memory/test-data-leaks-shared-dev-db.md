---
name: Integration tests leak into the shared dev DB
description: Why server integration tests can pollute the dev database and the cleanup rule that prevents it.
---

# Integration tests run against the shared dev DATABASE_URL

The api-server route/integration tests (`artifacts/api-server/src/routes/__tests__/*`) boot the
real Express app and write to the **same** database the dev app uses (`DATABASE_URL`), not an
isolated/ephemeral DB. So any row a test creates and fails to delete shows up as "mock data" in
the live CRM UI (e.g. the Admin API Keys list).

## Rule (and why)

- Test teardown MUST actually remove every row it created, and the delete MUST be **observable** —
  do NOT wrap teardown deletes in `.catch(() => {})`. Let cleanup failures throw so CI fails loudly.
  Optionally assert the rows are gone after deleting.
  **Why:** a swallowed teardown error is invisible. One broken delete repeated across ~173 runs
  left 519 api_keys + 173 firms + 346 users of garbage in the dev DB before anyone noticed.

- Watch for FK cascades in teardown ORDER. If a child delete silently no-ops (e.g. an api_key that
  references a firm), the later parent delete (the firm) FK-fails — and if that's also swallowed,
  the leak compounds across multiple tables from a single root bug.

## How to apply

When writing/reviewing a server test that inserts rows: select test rows by a run-unique marker
(e.g. a `Date.now()` suffix in the name/email), delete children before parents, surface teardown
errors, and guarantee server `close()` runs via `try/finally`.
