import { pgTable, serial, varchar, text, timestamp, integer, boolean } from "drizzle-orm/pg-core";
import { firmsTable } from "./firms";

export const usersTable = pgTable("mtos_users", {
  id: serial("id").primaryKey(),
  email: varchar("email", { length: 255 }).notNull().unique(),
  name: varchar("name", { length: 255 }).notNull(),
  role: varchar("role", { length: 20 }).notNull().default("viewer"),
  // Single-firm shell for MVI. Every user belongs to exactly one firm; the
  // FK + NOT NULL is the relational invariant the auth contract relies on
  // (req.user.firm_id is sourced from this column on every login). Backfill
  // for legacy rows runs in seedDefaultFirm() on boot.
  firm_id: integer("firm_id").notNull().references(() => firmsTable.id),
  password_hash: text("password_hash").notNull(),
  token_version: integer("token_version").notNull().default(0),
  totp_secret: text("totp_secret"),
  mfa_enabled: boolean("mfa_enabled").notNull().default(false),
  failed_login_attempts: integer("failed_login_attempts").notNull().default(0),
  locked_until: timestamp("locked_until"),
  // Email verification gate (Task #56). Public registration creates a
  // row in a "pending" state — `email_verified_at` IS NULL — and emails a
  // single-use token. Login refuses any account whose `email_verified_at`
  // is still NULL. The token itself is stored only as a SHA-256 hash so
  // the plaintext lives in the recipient's inbox and nowhere else; the
  // token row is invalidated by clearing both `*_token_hash` and
  // `*_token_expires_at` once the link is consumed (single-use).
  // Pre-existing rows (created before this column existed) are
  // backfilled to verified at boot via backfillEmailVerifiedAt().
  email_verified_at: timestamp("email_verified_at"),
  email_verification_token_hash: text("email_verification_token_hash"),
  email_verification_token_expires_at: timestamp("email_verification_token_expires_at"),
  created_at: timestamp("created_at").defaultNow().notNull(),
  updated_at: timestamp("updated_at").defaultNow().notNull(),
});

export const refreshTokensTable = pgTable("refresh_tokens", {
  id: serial("id").primaryKey(),
  user_id: integer("user_id").notNull(),
  token_hash: text("token_hash").notNull(),
  expires_at: timestamp("expires_at").notNull(),
  revoked: boolean("revoked").notNull().default(false),
  replaced_by: text("replaced_by"),
  created_at: timestamp("created_at").defaultNow().notNull(),
});
