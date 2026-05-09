import { pgTable, serial, text, timestamp, integer, index } from "drizzle-orm/pg-core";
import { usersTable } from "./users";
import { firmsTable } from "./firms";

export const apiKeysTable = pgTable("api_keys", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  key_hash: text("key_hash").notNull().unique(),
  key_prefix: text("key_prefix").notNull(),
  scopes: text("scopes").array().notNull().default([]),
  firm_id: integer("firm_id").notNull().references(() => firmsTable.id),
  created_by_user_id: integer("created_by_user_id").notNull().references(() => usersTable.id),
  last_used_at: timestamp("last_used_at"),
  revoked_at: timestamp("revoked_at"),
  created_at: timestamp("created_at").defaultNow().notNull(),
}, (t) => ({
  hashIdx: index("api_keys_hash_idx").on(t.key_hash),
  firmIdx: index("api_keys_firm_idx").on(t.firm_id),
}));

export const apiKeyAuditTable = pgTable("api_key_audit", {
  id: serial("id").primaryKey(),
  api_key_id: integer("api_key_id").notNull().references(() => apiKeysTable.id, { onDelete: "cascade" }),
  route: text("route").notNull(),
  method: text("method").notNull(),
  status_code: integer("status_code").notNull(),
  ip_address: text("ip_address"),
  user_agent: text("user_agent"),
  occurred_at: timestamp("occurred_at").defaultNow().notNull(),
}, (t) => ({
  keyIdx: index("api_key_audit_key_idx").on(t.api_key_id, t.occurred_at),
  occurredIdx: index("api_key_audit_occurred_idx").on(t.occurred_at),
}));
