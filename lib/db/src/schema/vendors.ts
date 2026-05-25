import {
  pgTable,
  serial,
  varchar,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const vendorsTable = pgTable("vendors", {
  id: serial("id").primaryKey(),
  name: varchar("name", { length: 255 }).notNull(),
  contact_name: varchar("contact_name", { length: 255 }),
  contact_email: varchar("contact_email", { length: 255 }),
  contact_phone: varchar("contact_phone", { length: 50 }),
  type: varchar("type", { length: 50 }).notNull().default("lead_gen"),
  status: varchar("status", { length: 20 }).notNull().default("active"),
  notes: text("notes"),
  // Opaque token shared with the vendor — resolves to this row on portal/form access.
  // 32 hex chars (16 random bytes). Never embed vendor name in this value.
  portal_token: varchar("portal_token", { length: 64 }).unique(),
  // Short internal code visible to CRM staff (e.g. "V-001"). Auto-assigned on create.
  internal_code: varchar("internal_code", { length: 20 }).unique(),
  created_at: timestamp("created_at").defaultNow().notNull(),
  updated_at: timestamp("updated_at").defaultNow().notNull(),
});

export const insertVendorSchema = createInsertSchema(vendorsTable).omit({
  id: true,
  created_at: true,
  updated_at: true,
});

export type InsertVendor = z.infer<typeof insertVendorSchema>;
export type Vendor = typeof vendorsTable.$inferSelect;
