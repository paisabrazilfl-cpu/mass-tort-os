import { pgTable, serial, text, timestamp, boolean, jsonb, integer, index } from "drizzle-orm/pg-core";

export const integrationsTable = pgTable("integrations", {
  id: serial("id").primaryKey(),
  // Multi-tenant scope. Nullable for legacy rows; backfilled by
  // `scripts/backfill-integrations-firm-id.sql`. New rows always carry
  // a firm_id stamped from `req.user.firm_id` at insert time. The CRUD
  // surface in routes/integrations.ts filters every read/write by this
  // column so an admin in firm A cannot read or rotate firm B's keys.
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
}, (t) => ({
  firmIdx: index("integrations_firm_id_idx").on(t.firm_id),
  firmProviderIdx: index("integrations_firm_provider_idx").on(t.firm_id, t.provider),
}));

