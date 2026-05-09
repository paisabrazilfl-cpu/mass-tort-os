import {
  pgTable,
  serial,
  varchar,
  integer,
  timestamp,
  text,
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
  // Tort + state routing (Task #52). NULL means "any" — operators don't
  // have to backfill every paralegal to keep round-robin working. Stored
  // as a text[] (postgres array) so a single paralegal can cover multiple
  // torts ("Camp Lejeune", "Roundup") and multiple states ("FL","GA","TX").
  // The lead-assignment n8n workflow filters on these via the
  // `?tort=` / `?state=` query params on GET /api/paralegals.
  assigned_torts: text("assigned_torts").array(),
  licensed_states: text("licensed_states").array(),
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
