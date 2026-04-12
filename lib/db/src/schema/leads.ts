import {
  pgTable,
  serial,
  varchar,
  text,
  boolean,
  decimal,
  timestamp,
  date,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const leadsTable = pgTable("leads", {
  id: serial("id").primaryKey(),
  name: varchar("name", { length: 255 }).notNull(),
  email: varchar("email", { length: 255 }),
  phone: varchar("phone", { length: 50 }),
  tort_type: varchar("tort_type", { length: 100 }).notNull(),
  exposure_start: date("exposure_start"),
  exposure_end: date("exposure_end"),
  diagnosis_confirmed: boolean("diagnosis_confirmed").notNull().default(false),
  diagnosis_type: varchar("diagnosis_type", { length: 255 }),
  was_at_location: boolean("was_at_location").notNull().default(false),
  location_name: varchar("location_name", { length: 255 }),
  status: varchar("status", { length: 20 }).notNull().default("new"),
  rejection_reason: text("rejection_reason"),
  notes: text("notes"),
  ad_spend: decimal("ad_spend", { precision: 10, scale: 2 }),
  source: varchar("source", { length: 100 }),
  created_at: timestamp("created_at").defaultNow().notNull(),
  updated_at: timestamp("updated_at").defaultNow().notNull(),
});

export const insertLeadSchema = createInsertSchema(leadsTable).omit({
  id: true,
  created_at: true,
  updated_at: true,
});

export type InsertLead = z.infer<typeof insertLeadSchema>;
export type Lead = typeof leadsTable.$inferSelect;
