import {
  pgTable,
  serial,
  integer,
  text,
  varchar,
  timestamp,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";
import { firmsTable } from "./firms";
import { usersTable } from "./users";

/**
 * Firm invites — single-use claim tokens that bind a new self-serve
 * registration to a specific firm instead of falling back to the seeded
 * default firm. The plaintext token is never persisted; the recipient
 * receives it in the invite link and the row stores only its SHA-256
 * hash so that DB compromise cannot replay the link.
 *
 * Lifecycle:
 *   1. Admin POSTs /firm-invites → row inserted with token_hash, optional
 *      email_prefill, expires_at (default 14d), claimed_* NULL.
 *   2. New user opens /register?invite=<token>; the public lookup returns
 *      email_prefill + the firm name (no token / hash exposure).
 *   3. POST /auth/register with invite_token uses a two-phase claim:
 *      first an atomic UPDATE stamps claimed_at = NOW() (and returns
 *      firm_id) so concurrent registrations cannot both bind to the same
 *      invite; then a follow-up UPDATE attaches the new user.id once
 *      createUser succeeds.
 *   4. Subsequent claims on the same row are rejected by the predicate
 *      `claimed_at IS NULL AND expires_at > NOW()`. Note that
 *      `claimed_at` (not `claimed_by_user_id`) is the authoritative
 *      single-use marker — claimed_by_user_id may briefly be NULL on a
 *      consumed row between the two phases.
 */
export const firmInvitesTable = pgTable(
  "firm_invites",
  {
    id: serial("id").primaryKey(),
    firm_id: integer("firm_id")
      .notNull()
      .references(() => firmsTable.id),
    // SHA-256 hex (64 chars) of the random token issued to the recipient.
    token_hash: text("token_hash").notNull(),
    // Optional pre-fill so the recipient sees the address the admin
    // intended to invite. The actual registration may use a different
    // address — the prefill is convenience, not a constraint.
    email_prefill: varchar("email_prefill", { length: 255 }),
    expires_at: timestamp("expires_at").notNull(),
    // Audit trail. The admin who minted the link is captured so
    // /firm-invites GET can render "invited by" without a join hop in the
    // common case.
    created_by_user_id: integer("created_by_user_id")
      .notNull()
      .references(() => usersTable.id),
    // Set atomically by the register handler when a valid claim wins. NULL
    // = still claimable. The FK lets a future "deactivate user" flow
    // cascade-clean if we ever need it.
    claimed_by_user_id: integer("claimed_by_user_id").references(
      () => usersTable.id,
    ),
    claimed_at: timestamp("claimed_at"),
    created_at: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => ({
    // Unique by token hash so a colliding token never matches two rows
    // (and so claim is a single-row UPDATE).
    tokenHashIdx: uniqueIndex("firm_invites_token_hash_idx").on(t.token_hash),
    // Common admin query: "show me my firm's invites, newest first."
    firmIdx: index("firm_invites_firm_id_idx").on(t.firm_id),
  }),
);

export type FirmInvite = typeof firmInvitesTable.$inferSelect;
