import { pgTable, serial, varchar, text, timestamp, boolean, integer, jsonb } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const buyersTable = pgTable("buyers", {
  id: serial("id").primaryKey(),
  name: varchar("name", { length: 255 }).notNull().unique(),
  legal_name: varchar("legal_name", { length: 255 }),
  contact_name: varchar("contact_name", { length: 255 }),
  contact_email: varchar("contact_email", { length: 255 }),
  contact_phone: varchar("contact_phone", { length: 50 }),
  notes: text("notes"),
  esign_provider_integration_id: integer("esign_provider_integration_id"),
  fax_provider_integration_id: integer("fax_provider_integration_id"),
  email_provider_integration_id: integer("email_provider_integration_id"),
  default_email_from_name: varchar("default_email_from_name", { length: 255 }),
  default_email_from_address: varchar("default_email_from_address", { length: 255 }),
  default_fax_from_number: varchar("default_fax_from_number", { length: 50 }),
  active: boolean("active").notNull().default(true),
  metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
  created_at: timestamp("created_at").defaultNow().notNull(),
  updated_at: timestamp("updated_at").defaultNow().notNull(),
});

export const insertBuyerSchema = createInsertSchema(buyersTable).omit({
  id: true,
  created_at: true,
  updated_at: true,
});

export type Buyer = typeof buyersTable.$inferSelect;
export type InsertBuyer = z.infer<typeof insertBuyerSchema>;
