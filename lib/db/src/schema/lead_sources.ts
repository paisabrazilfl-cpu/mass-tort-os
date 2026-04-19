import { pgTable, serial, varchar, decimal, timestamp, boolean } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const leadSourcesTable = pgTable("lead_sources", {
  id: serial("id").primaryKey(),
  name: varchar("name", { length: 255 }).notNull().unique(),
  channel: varchar("channel", { length: 50 }).notNull().default("other"),
  cost_per_lead: decimal("cost_per_lead", { precision: 10, scale: 2 }),
  historical_qualified_rate: decimal("historical_qualified_rate", { precision: 5, scale: 4 }),
  historical_retained_rate: decimal("historical_retained_rate", { precision: 5, scale: 4 }),
  active: boolean("active").notNull().default(true),
  created_at: timestamp("created_at").defaultNow().notNull(),
  updated_at: timestamp("updated_at").defaultNow().notNull(),
});

export const insertLeadSourceSchema = createInsertSchema(leadSourcesTable).omit({
  id: true,
  created_at: true,
  updated_at: true,
});

export type LeadSource = typeof leadSourcesTable.$inferSelect;
export type InsertLeadSource = z.infer<typeof insertLeadSourceSchema>;
