---
name: Self-fix rule
description: Owner rule — never ask the user to fix something the agent can fix itself. Always self-reflect first.
---

# Self-fix rule (owner standing rule — permanent)

## The rule

Before surfacing any problem to the user, ask: **"Can I fix this myself?"**

- If YES → fix it silently. Do not report the problem as a blocker.
- If NO (requires owner credentials, external system access, DNS change, physical action) → report it clearly with the specific blocker.

## What this covers

- TypeScript errors → fix the code.
- Test failures → fix the cause.
- Missing imports → add them.
- Broken JSX structure → repair it.
- API errors with known causes → implement the correct call.
- Lint/formatting issues → fix in place.
- DB inconsistencies the agent can correct via SQL → run the correction.

## What requires the user

- DNS record changes (registrar access is owner-only).
- Render dashboard manual secret entries.
- Third-party dashboard actions (e.g. Resend domain verification, Twilio EIN submission).
- Credentials or API keys the agent does not have.
- Legal/compliance decisions.

**Why:** Owner set this 2026-06-04. Asking the user to fix things the agent can handle is wasteful and breaks trust.

**How to apply:** At every error or roadblock — reflect before reporting. Only escalate genuine blockers.
