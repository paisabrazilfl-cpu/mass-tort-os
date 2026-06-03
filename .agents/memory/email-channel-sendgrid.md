---
name: Email channel (SendGrid) tracking & quirks
description: Durable lessons for outbound email tracking, SendGrid delivery realities, and the schema-reproducibility rule when adding a table.
---

# Email channel — durable lessons

## All lead-facing outbound email must go through the single tracked send path
Outbound email is persisted (mirrors the SMS message model) so bounces/deliveries
are visible on the lead. Any NEW outbound email path that calls a provider adapter
directly re-introduces the old fire-and-forget gap (a 202 was logged, a bounce was
invisible). **Why:** delivery state is only knowable via the webhook, which can only
update a row that the send path created.

## Only mutate delivery state on a verified webhook signature
The webhook records every event for audit, but it must advance status ONLY when the
provider signature is `verified` (mirror SMS) — an unsigned/unverified event must not
be allowed to falsify delivery status.

## SendGrid correlation + delivery realities
- SendGrid's Event-Webhook `sg_message_id` is `<X-Message-Id>.<suffix>`; correlate on
  exact match OR the prefix before the first ".".
- Email genuinely DELIVERS (verified sender, valid key) unlike SMS 10DLC. A 202 = accepted,
  not delivered (confirm via Activity API). A `@gmail.com` from-address is a DMARC spam
  risk — authenticate the mtosvelocity.com domain for real deliverability.

## Adding a table: dev DDL alone is NOT reproducible — commit the migration SQL
`apply-schema.mjs` bootstraps a FRESH DB by replaying every committed
`lib/db/drizzle/*.sql` file (split on `--> statement-breakpoint`); it does NOT apply
additive DDL to already-provisioned DBs. So applying a `CREATE TABLE` only to the dev
DB leaves fresh deploys missing the table. **Always commit the DDL as a numbered
`lib/db/drizzle/NNNN_*.sql` file** (it concatenates after `0000` in lexical order).
**Why:** code review blocks "schema not reproducible" — the table must exist in
committed artifacts, not just in a live DB.

## drizzle-kit generate/push are TTY-bound here and the snapshot is stale
`push` and `generate` prompt interactively ("Is X created or renamed from another
table?") — arrow-key selection that can't be piped. The committed drizzle snapshot is
also stale vs the TS schema (e.g. `favorites`, the DB-only orphans `conversations`/
`messages`), so `generate` surfaces unrelated diffs and rename prompts. Hand-authoring
the numbered `.sql` file (matching the schema, drizzle style) is the reliable path;
verify it by replaying it into a dropped dev table and running db-drift.
