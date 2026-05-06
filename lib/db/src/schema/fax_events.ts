import { pgTable, serial, integer, varchar, text, timestamp, jsonb, index } from "drizzle-orm/pg-core";

/**
 * Inbound fax-provider webhook events (sent/delivered/failed/received).
 * firm_id and lead_id are populated when external_fax_id correlates to
 * an outbound fax we logged in workflow_runs; otherwise they stay null
 * and the row is still durable for audit. signature_status follows the
 * same convention as email_events.
 */
export const faxEventsTable = pgTable(
  "fax_events",
  {
    id: serial("id").primaryKey(),
    integration_id: integer("integration_id"),
    firm_id: integer("firm_id"),
    lead_id: integer("lead_id"),
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
    leadIdx: index("fax_events_lead_idx").on(t.lead_id),
    firmIdx: index("fax_events_firm_idx").on(t.firm_id, t.received_at),
  }),
);

export type FaxEvent = typeof faxEventsTable.$inferSelect;
