import { pgTable, serial, integer, varchar, boolean, timestamp, index } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

/**
 * Dedicated inbound phone numbers, one (or more) per tort/campaign.
 *
 * The operator buys/assigns one phone number per tort and records the
 * mapping here. When a caller dials that number, the Vapi webhook resolves
 * the dialed (destination) number to its tort so the right intake "form"
 * (the tort's dedicated voice agent + capture schema) is used and the call
 * is attributed correctly — even when the Vapi assistant metadata is
 * missing.
 *
 * `phone_number` is the E.164 number the caller dials (our number).
 * `vapi_phone_number_id` is the optional Vapi phone-number resource id so
 * the management API can best-effort assign the tort's assistant to it.
 */
export const tortPhoneNumbersTable = pgTable(
  "tort_phone_numbers",
  {
    id: serial("id").primaryKey(),
    tort_id: varchar("tort_id", { length: 80 }).notNull(),
    phone_number: varchar("phone_number", { length: 32 }).notNull().unique(),
    vapi_phone_number_id: varchar("vapi_phone_number_id", { length: 100 }),
    label: varchar("label", { length: 200 }),
    active: boolean("active").notNull().default(true),
    firm_id: integer("firm_id"),
    created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updated_at: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => ({
    phoneIdx: index("tort_phone_numbers_phone_number_idx").on(t.phone_number),
    tortIdx: index("tort_phone_numbers_tort_id_idx").on(t.tort_id),
  }),
);

export const insertTortPhoneNumberSchema = createInsertSchema(tortPhoneNumbersTable).omit({
  id: true,
  created_at: true,
  updated_at: true,
});
export type InsertTortPhoneNumber = z.infer<typeof insertTortPhoneNumberSchema>;
export type TortPhoneNumber = typeof tortPhoneNumbersTable.$inferSelect;
