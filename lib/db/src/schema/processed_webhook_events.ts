import { pgTable, serial, text, integer, timestamp, uniqueIndex } from "drizzle-orm/pg-core";

export const processedWebhookEventsTable = pgTable(
  "processed_webhook_events",
  {
    id: serial("id").primaryKey(),
    provider: text("provider").notNull(),
    external_event_id: text("external_event_id").notNull(),
    firm_id: integer("firm_id"),
    integration_id: integer("integration_id"),
    event_type: text("event_type"),
    processed_at: timestamp("processed_at").defaultNow().notNull(),
  },
  (t) => [uniqueIndex("pwe_provider_event_uniq").on(t.provider, t.external_event_id)],
);
