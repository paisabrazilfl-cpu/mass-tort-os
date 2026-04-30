import {
  pgTable,
  serial,
  integer,
  varchar,
  text,
  timestamp,
  index,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

/**
 * Outbound + inbound SMS messages handled by the Telnyx adapter. Each
 * row is one message. Status transitions are driven by the
 * /api/webhooks/telnyx/sms delivery webhook. `to_phone_e164` is stored
 * in canonical +<digits> form so the UI never has to format it.
 */
export const smsMessagesTable = pgTable(
  "sms_messages",
  {
    id: serial("id").primaryKey(),
    firm_id: integer("firm_id"),
    lead_id: integer("lead_id"),
    direction: varchar("direction", { length: 10 }).notNull().default("outbound"),
    from_phone_e164: varchar("from_phone_e164", { length: 20 }),
    to_phone_e164: varchar("to_phone_e164", { length: 20 }).notNull(),
    body: text("body").notNull(),
    telnyx_message_id: varchar("telnyx_message_id", { length: 100 }),
    status: varchar("status", { length: 30 }).notNull().default("queued"),
    error: text("error"),
    sent_at: timestamp("sent_at"),
    delivered_at: timestamp("delivered_at"),
    failed_at: timestamp("failed_at"),
    created_by_user_id: integer("created_by_user_id"),
    created_at: timestamp("created_at").defaultNow().notNull(),
    updated_at: timestamp("updated_at").defaultNow().notNull(),
  },
  (t) => ({
    leadIdx: index("sms_messages_lead_id_idx").on(t.lead_id),
    firmIdx: index("sms_messages_firm_id_idx").on(t.firm_id),
    telnyxIdIdx: index("sms_messages_telnyx_message_id_idx").on(t.telnyx_message_id),
    statusCreatedIdx: index("sms_messages_status_created_at_idx").on(t.status, t.created_at),
  }),
);

export const insertSmsMessageSchema = createInsertSchema(smsMessagesTable).omit({
  id: true,
  created_at: true,
  updated_at: true,
});

export type InsertSmsMessage = z.infer<typeof insertSmsMessageSchema>;
export type SmsMessage = typeof smsMessagesTable.$inferSelect;
