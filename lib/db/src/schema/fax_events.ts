import { pgTable, serial, integer, varchar, text, timestamp, jsonb, index } from "drizzle-orm/pg-core";

export const faxEventsTable = pgTable(
  "fax_events",
  {
    id: serial("id").primaryKey(),
    integration_id: integer("integration_id"),
    provider: varchar("provider", { length: 64 }).notNull(),
    external_fax_id: varchar("external_fax_id", { length: 255 }),
    event_type: varchar("event_type", { length: 64 }).notNull(),
    status: varchar("status", { length: 64 }),
    pages: integer("pages"),
    signature_status: varchar("signature_status", { length: 32 }).notNull().default("unknown"),
    raw_payload: jsonb("raw_payload").$type<Record<string, unknown>>(),
    error: text("error"),
    occurred_at: timestamp("occurred_at"),
    received_at: timestamp("received_at").defaultNow().notNull(),
  },
  (t) => ({
    faxIdx: index("fax_events_fax_idx").on(t.external_fax_id),
    providerIdx: index("fax_events_provider_idx").on(t.provider, t.received_at),
  }),
);

export type FaxEvent = typeof faxEventsTable.$inferSelect;
