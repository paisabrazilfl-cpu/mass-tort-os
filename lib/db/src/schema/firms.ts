import {
  pgTable,
  serial,
  varchar,
  text,
  timestamp,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const firmsTable = pgTable(
  "firms",
  {
    id: serial("id").primaryKey(),
    name: varchar("name", { length: 255 }).notNull(),
    slug: varchar("slug", { length: 100 }).notNull(),
    billing_email: varchar("billing_email", { length: 255 }),
    stripe_customer_id: varchar("stripe_customer_id", { length: 100 }),
    stripe_subscription_id: varchar("stripe_subscription_id", { length: 100 }),
    subscription_status: varchar("subscription_status", { length: 30 })
      .notNull()
      .default("inactive"),
    current_period_end: timestamp("current_period_end"),
    plan_price_id: varchar("plan_price_id", { length: 100 }),
    notes: text("notes"),
    created_at: timestamp("created_at").defaultNow().notNull(),
    updated_at: timestamp("updated_at").defaultNow().notNull(),
  },
  (t) => ({
    slugIdx: uniqueIndex("firms_slug_idx").on(t.slug),
    stripeCustIdx: index("firms_stripe_customer_id_idx").on(t.stripe_customer_id),
    stripeSubIdx: index("firms_stripe_subscription_id_idx").on(t.stripe_subscription_id),
  }),
);

export const insertFirmSchema = createInsertSchema(firmsTable).omit({
  id: true,
  created_at: true,
  updated_at: true,
});

export type InsertFirm = z.infer<typeof insertFirmSchema>;
export type Firm = typeof firmsTable.$inferSelect;
