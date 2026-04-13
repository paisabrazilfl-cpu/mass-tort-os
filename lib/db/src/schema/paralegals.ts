import {
  pgTable,
  serial,
  varchar,
  integer,
  timestamp,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const paralegalsTable = pgTable("paralegals", {
  id: serial("id").primaryKey(),
  name: varchar("name", { length: 255 }).notNull(),
  email: varchar("email", { length: 255 }),
  role: varchar("role", { length: 100 }).notNull().default("Paralegal"),
  active_cases: integer("active_cases").notNull().default(0),
  signed_cases: integer("signed_cases").notNull().default(0),
  total_assigned: integer("total_assigned").notNull().default(0),
  created_at: timestamp("created_at").defaultNow().notNull(),
  updated_at: timestamp("updated_at").defaultNow().notNull(),
});

export const insertParalegalSchema = createInsertSchema(paralegalsTable).omit({
  id: true,
  created_at: true,
  updated_at: true,
});

export type InsertParalegal = z.infer<typeof insertParalegalSchema>;
export type Paralegal = typeof paralegalsTable.$inferSelect;
