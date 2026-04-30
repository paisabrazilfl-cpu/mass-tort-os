import { pgTable, serial, varchar, text, timestamp, integer, boolean } from "drizzle-orm/pg-core";

export const usersTable = pgTable("mtos_users", {
  id: serial("id").primaryKey(),
  email: varchar("email", { length: 255 }).notNull().unique(),
  name: varchar("name", { length: 255 }).notNull(),
  role: varchar("role", { length: 20 }).notNull().default("viewer"),
  // Single-firm shell for MVI. Every user belongs to exactly one firm.
  // Nullable at the column level so the migration can backfill safely;
  // application code treats missing firm_id as a fatal config error.
  firm_id: integer("firm_id"),
  password_hash: text("password_hash").notNull(),
  token_version: integer("token_version").notNull().default(0),
  totp_secret: text("totp_secret"),
  mfa_enabled: boolean("mfa_enabled").notNull().default(false),
  failed_login_attempts: integer("failed_login_attempts").notNull().default(0),
  locked_until: timestamp("locked_until"),
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
