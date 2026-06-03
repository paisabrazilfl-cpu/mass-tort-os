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
 * Outbound email messages dispatched through the email provider router.
 * Each row is one send, keyed to firm/lead so the lead detail view can
 * show whether an intake confirmation or document email actually reached
 * the claimant. This mirrors `sms_messages`: the send path inserts a
 * `queued` row, flips it to `sent`/`failed` once the provider accepts (or
 * rejects) the request, and the /api/webhooks/email/:provider receiver
 * advances it to delivered/bounced/dropped/spamreport from the provider's
 * Event Webhook. `external_message_id` stores the provider id returned at
 * send time (SendGrid X-Message-Id); inbound events correlate against it.
 */
export const emailMessagesTable = pgTable(
  "email_messages",
  {
    id: serial("id").primaryKey(),
    firm_id: integer("firm_id"),
    lead_id: integer("lead_id"),
    direction: varchar("direction", { length: 10 }).notNull().default("outbound"),
    from_email: varchar("from_email", { length: 320 }),
    to_email: varchar("to_email", { length: 320 }).notNull(),
    to_name: varchar("to_name", { length: 255 }),
    subject: varchar("subject", { length: 998 }),
    provider: varchar("provider", { length: 32 }),
    /**
     * Provider-agnostic external id returned by the send call (SendGrid
     * X-Message-Id, Postmark MessageID, Resend id, …). Event-webhook
     * correlation matches against this; for SendGrid the event's
     * `sg_message_id` is `<external_message_id>.<suffix>`, so the webhook
     * also matches on the prefix before the first ".".
     */
    external_message_id: varchar("external_message_id", { length: 255 }),
    /** queued | sent | delivered | bounced | dropped | spamreport | deferred | failed */
    status: varchar("status", { length: 30 }).notNull().default("queued"),
    error: text("error"),
    sent_at: timestamp("sent_at"),
    delivered_at: timestamp("delivered_at"),
    bounced_at: timestamp("bounced_at"),
    failed_at: timestamp("failed_at"),
    created_by_user_id: integer("created_by_user_id"),
    created_at: timestamp("created_at").defaultNow().notNull(),
    updated_at: timestamp("updated_at").defaultNow().notNull(),
  },
  (t) => ({
    leadIdx: index("email_messages_lead_id_idx").on(t.lead_id),
    firmIdx: index("email_messages_firm_id_idx").on(t.firm_id),
    externalMessageIdIdx: index("email_messages_external_message_id_idx").on(t.external_message_id),
    statusCreatedIdx: index("email_messages_status_created_at_idx").on(t.status, t.created_at),
    firmSentAtIdx: index("email_messages_firm_sent_at_idx").on(t.firm_id, t.sent_at),
  }),
);

export const insertEmailMessageSchema = createInsertSchema(emailMessagesTable).omit({
  id: true,
  created_at: true,
  updated_at: true,
});

export type InsertEmailMessage = z.infer<typeof insertEmailMessageSchema>;
export type EmailMessage = typeof emailMessagesTable.$inferSelect;
