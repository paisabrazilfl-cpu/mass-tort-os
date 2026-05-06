import { pgTable, serial, integer, varchar, text, timestamp, jsonb, index } from "drizzle-orm/pg-core";

/**
 * Inbound email-provider webhook events (delivered/opened/bounced/etc).
 * One row per provider event. firm_id and lead_id are populated when the
 * external_message_id can be correlated to an outbound send we logged in
 * sms_messages or workflow_runs; otherwise they stay null and the row is
 * still durable for audit. signature_status is "verified" only when the
 * provider's documented signature scheme passed; "invalid" when present
 * but failed; "unverified" when the provider did not present one.
 */
export const emailEventsTable = pgTable(
  "email_events",
  {
    id: serial("id").primaryKey(),
    integration_id: integer("integration_id"),
    firm_id: integer("firm_id"),
    lead_id: integer("lead_id"),
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
    leadIdx: index("email_events_lead_idx").on(t.lead_id),
    firmIdx: index("email_events_firm_idx").on(t.firm_id, t.received_at),
  }),
);

export type EmailEvent = typeof emailEventsTable.$inferSelect;
