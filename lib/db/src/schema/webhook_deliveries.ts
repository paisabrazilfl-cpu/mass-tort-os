import {
  pgTable,
  serial,
  integer,
  text,
  smallint,
  jsonb,
  timestamp,
  index,
} from "drizzle-orm/pg-core";

export const webhookDeliveriesTable = pgTable(
  "webhook_deliveries",
  {
    id: serial("id").primaryKey(),
    integration_id: integer("integration_id").notNull(),
    event: text("event").notNull(),
    delivery_id: text("delivery_id").notNull(),
    status_code: integer("status_code"),
    response_ms: integer("response_ms"),
    attempt: smallint("attempt").notNull().default(1),
    last_error: text("last_error"),
    payload_hash: text("payload_hash"),
    payload: jsonb("payload"),
    is_test: integer("is_test").notNull().default(0),
    occurred_at: timestamp("occurred_at").defaultNow().notNull(),
  },
  (t) => ({
    integrationIdx: index("webhook_deliveries_integration_idx").on(
      t.integration_id,
      t.occurred_at,
    ),
    eventIdx: index("webhook_deliveries_event_idx").on(t.event, t.occurred_at),
    deliveryIdx: index("webhook_deliveries_delivery_idx").on(t.delivery_id),
    occurredAtIdx: index("webhook_deliveries_occurred_at_idx").on(t.occurred_at),
  }),
);

export type WebhookDelivery = typeof webhookDeliveriesTable.$inferSelect;
export type InsertWebhookDelivery = typeof webhookDeliveriesTable.$inferInsert;
