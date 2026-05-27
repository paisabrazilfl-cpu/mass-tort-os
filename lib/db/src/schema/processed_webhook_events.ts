import {
  pgTable,
  serial,
  integer,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

export const processedWebhookEventsTable = pgTable("processed_webhook_events", {
  id: serial("id").primaryKey(),
  provider: text("provider").notNull(),
  external_event_id: text("external_event_id").notNull(),
  firm_id: integer("firm_id"),
  integration_id: integer("integration_id"),
  event_type: text("event_type"),
  created_at: timestamp("created_at").defaultNow().notNull(),
}, (t) => ({
  providerEventIdx: uniqueIndex("processed_webhook_events_provider_ext_id_idx").on(t.provider, t.external_event_id),
}));

export type ProcessedWebhookEvent = typeof processedWebhookEventsTable.$inferSelect;
