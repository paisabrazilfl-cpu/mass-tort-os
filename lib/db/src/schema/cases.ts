import {
  pgTable,
  varchar,
  jsonb,
  timestamp,
  integer,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const casesTable = pgTable("cases", {
  id: varchar("id", { length: 36 }).primaryKey(),
  data: jsonb("data"),
  status: varchar("status", { length: 50 }).notNull().default("open"),
  // RBAC ownership columns (Task #10). Both nullable so historical rows
  // pre-dating these columns read as "no owner / no assignee" — the route
  // layer treats null as paralegal+/admin-only visibility and never as
  // "anyone can see it". The viewer role is filtered to rows where it
  // either OWNS (created_by_user_id) or is ASSIGNED TO (assigned_to) the
  // case. This mirrors the leads table convention.
  created_by_user_id: integer("created_by_user_id"),
  assigned_to: integer("assigned_to"),
  created_at: timestamp("created_at").defaultNow().notNull(),
  updated_at: timestamp("updated_at").defaultNow().notNull(),
});

export const insertCaseSchema = createInsertSchema(casesTable).omit({
  created_at: true,
  updated_at: true,
});

export type InsertCase = z.infer<typeof insertCaseSchema>;
export type Case = typeof casesTable.$inferSelect;
