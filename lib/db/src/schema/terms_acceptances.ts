import { pgTable, serial, varchar, text, timestamp, integer, index } from "drizzle-orm/pg-core";
import { usersTable } from "./users";

/**
 * Immutable audit trail of clickwrap Terms & Conditions acceptances.
 *
 * One row is written every time a user manifests assent to the Terms — today
 * that is at first signup (the clickwrap gate on /api/auth/register). The row
 * captures WHICH version was accepted (`terms_version`) plus a SHA-256 of the
 * exact text shown (`content_sha256`), so a later edit to the canonical
 * document can never silently rewrite what someone agreed to. `ip_address`
 * and `user_agent` are recorded as reasonable-notice / manifest-assent
 * evidence for clickwrap enforceability (E-SIGN Act / UETA).
 *
 * Rows are never updated or deleted in the normal flow — re-acceptance (e.g.
 * a future terms-changed gate) appends a new row.
 */
export const termsAcceptancesTable = pgTable(
  "mtos_terms_acceptances",
  {
    id: serial("id").primaryKey(),
    // The accepting user. Set at registration once the user row exists.
    user_id: integer("user_id")
      .notNull()
      .references(() => usersTable.id),
    // Denormalized email captured at acceptance time, so the record stays
    // legible even if the user row is later renamed/removed.
    email: varchar("email", { length: 254 }).notNull(),
    // Version string of the canonical document the user agreed to (e.g. "1.0").
    terms_version: varchar("terms_version", { length: 32 }).notNull(),
    // SHA-256 (hex) of the exact terms text presented + accepted.
    content_sha256: text("content_sha256").notNull(),
    // Reasonable-notice / manifest-assent evidence.
    ip_address: varchar("ip_address", { length: 64 }),
    user_agent: text("user_agent"),
    accepted_at: timestamp("accepted_at").defaultNow().notNull(),
  },
  (t) => ({
    userIdx: index("mtos_terms_acceptances_user_idx").on(t.user_id),
    versionIdx: index("mtos_terms_acceptances_version_idx").on(t.terms_version),
  }),
);

export type TermsAcceptance = typeof termsAcceptancesTable.$inferSelect;
export type NewTermsAcceptance = typeof termsAcceptancesTable.$inferInsert;
