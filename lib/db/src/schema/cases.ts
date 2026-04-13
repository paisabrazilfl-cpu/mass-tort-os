import {
  pgTable,
  varchar,
  jsonb,
  timestamp,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const casesTable = pgTable("cases", {
  id: varchar("id", { length: 36 }).primaryKey(),
  data: jsonb("data"),
  status: varchar("status", { length: 50 }).notNull().default("open"),
  created_at: timestamp("created_at").defaultNow().notNull(),
  updated_at: timestamp("updated_at").defaultNow().notNull(),
});

export const insertCaseSchema = createInsertSchema(casesTable).omit({
  created_at: true,
  updated_at: true,
});

export type InsertCase = z.infer<typeof insertCaseSchema>;
export type Case = typeof casesTable.$inferSelect;
