import { pgTable, serial, text, timestamp, boolean, jsonb, integer } from "drizzle-orm/pg-core";

export const integrationsTable = pgTable("integrations", {
  id: serial("id").primaryKey(),
  firm_id: integer("firm_id"),
  name: text("name").notNull(),
  type: text("type").notNull(),
  provider: text("provider").notNull(),
  status: text("status").notNull().default("inactive"),
  api_url: text("api_url"),
  api_key_hash: text("api_key_hash"),
  webhook_url: text("webhook_url"),
  config: jsonb("config"),
  last_sync_at: timestamp("last_sync_at"),
  sync_direction: text("sync_direction").default("bidirectional"),
  field_mapping: jsonb("field_mapping"),
  created_at: timestamp("created_at").defaultNow(),
  updated_at: timestamp("updated_at").defaultNow(),
});
