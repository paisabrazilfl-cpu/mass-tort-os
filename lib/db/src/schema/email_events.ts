import { pgTable, serial, integer, varchar, text, timestamp, jsonb, index } from "drizzle-orm/pg-core";

export const emailEventsTable = pgTable(
  "email_events",
  {
    id: serial("id").primaryKey(),
    integration_id: integer("integration_id"),
    provider: varchar("provider", { length: 64 }).notNull(),
    external_message_id: varchar("external_message_id", { length: 255 }),
    event_type: varchar("event_type", { length: 64 }).notNull(),
    recipient_email: varchar("recipient_email", { length: 320 }),
    signature_status: varchar("signature_status", { length: 32 }).notNull().default("unknown"),
    raw_payload: jsonb("raw_payload").$type<Record<string, unknown>>(),
    error: text("error"),
    occurred_at: timestamp("occurred_at"),
    received_at: timestamp("received_at").defaultNow().notNull(),
  },
  (t) => ({
    msgIdx: index("email_events_msg_idx").on(t.external_message_id),
    providerIdx: index("email_events_provider_idx").on(t.provider, t.received_at),
  }),
);

export type EmailEvent = typeof emailEventsTable.$inferSelect;
