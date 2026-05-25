import {
  pgTable,
  serial,
  integer,
  varchar,
  text,
  boolean,
  timestamp,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { leadsTable } from "./leads";
import { firmsTable } from "./firms";

// Client-facing portal accounts — one per lead (one per client).
// Intentionally separate from mtos_users: clients are not firm employees,
// carry no role/permission model, and are scoped entirely to their own lead.
// Auth follows the same patterns as mtos_users (scrypt, TOTP, token_version
// revocation) so the same security primitives apply without sharing tables.
export const portalUsersTable = pgTable(
  "portal_users",
  {
    id: serial("id").primaryKey(),

    // Owning lead — cascade delete so removing a lead cleans up the portal account.
    lead_id: integer("lead_id")
      .notNull()
      .references(() => leadsTable.id, { onDelete: "cascade" }),

    // Firm scope — every portal account belongs to exactly one firm.
    firm_id: integer("firm_id")
      .notNull()
      .references(() => firmsTable.id, { onDelete: "cascade" }),

    // Contact identity (copied from lead at signup, not re-queried each request).
    email: varchar("email", { length: 255 }).notNull(),
    name: varchar("name", { length: 255 }).notNull(),

    // scrypt hash in the same "salt:derivedKey" format used by mtos_users.
    password_hash: text("password_hash"),

    // Bump on logout / password-change to invalidate all outstanding JWTs.
    token_version: integer("token_version").notNull().default(0),

    // TOTP — secret encrypted at rest with ENCRYPTION_KEY_V1.
    totp_secret: text("totp_secret"),
    // mfa_enabled: secret has been generated and stored.
    // mfa_verified: client has confirmed a valid TOTP code at least once.
    // Login gate: both must be true before dashboard access is granted.
    mfa_enabled: boolean("mfa_enabled").notNull().default(false),
    mfa_verified: boolean("mfa_verified").notNull().default(false),

    // Email verification gate — mirrors mtos_users pattern.
    // NULL = pending; set on link click (single-use token, hash-only storage).
    email_verified_at: timestamp("email_verified_at"),
    email_verification_token_hash: text("email_verification_token_hash"),
    email_verification_token_expires_at: timestamp("email_verification_token_expires_at"),

    // One-time signup token issued when the background check passes.
    // Hash-only storage; plaintext lives in the client's inbox.
    // Consuming this token creates the password_hash and starts the flow.
    signup_token_hash: text("signup_token_hash"),
    signup_token_expires_at: timestamp("signup_token_expires_at"),

    // Security hardening — mirrors mtos_users lockout pattern.
    last_login_at: timestamp("last_login_at"),
    failed_login_attempts: integer("failed_login_attempts").notNull().default(0),
    locked_until: timestamp("locked_until"),

    created_at: timestamp("created_at").defaultNow().notNull(),
    updated_at: timestamp("updated_at").defaultNow().notNull(),
  },
  (t) => ({
    // Email is unique firm-wide (one portal account per email address per firm).
    emailFirmIdx: uniqueIndex("portal_users_email_firm_idx").on(t.email, t.firm_id),
    // One portal account per lead — a lead cannot have two portal logins.
    leadIdx: uniqueIndex("portal_users_lead_idx").on(t.lead_id),
    firmIdx: index("portal_users_firm_idx").on(t.firm_id),
    signupTokenIdx: index("portal_users_signup_token_idx").on(t.signup_token_hash),
  }),
);

export const insertPortalUserSchema = createInsertSchema(portalUsersTable).omit({
  id: true,
  created_at: true,
  updated_at: true,
});

export type InsertPortalUser = z.infer<typeof insertPortalUserSchema>;
export type PortalUser = typeof portalUsersTable.$inferSelect;
