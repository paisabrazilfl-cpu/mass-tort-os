import { pgTable, serial, varchar, text, timestamp, boolean, integer, primaryKey } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { documentTemplatesTable } from "./document_templates";
import { buyersTable } from "./buyers";

/**
 * Per-(buyer, tort) toggle for whether a given template should be sent.
 * Three-tier resolution at send time:
 *   1. Row exists for (buyer_id, tort_type, template_id) → use enabled flag
 *   2. Row exists for (buyer_id=NULL, tort_type, template_id) → tort-wide default
 *   3. Falls back to template default (active=true means send by default)
 */
export const templateAssignmentsTable = pgTable("template_assignments", {
  id: serial("id").primaryKey(),
  template_id: integer("template_id")
    .notNull()
    .references(() => documentTemplatesTable.id, { onDelete: "cascade" }),
  buyer_id: integer("buyer_id").references(() => buyersTable.id, { onDelete: "cascade" }),
  tort_type: varchar("tort_type", { length: 100 }),
  enabled: boolean("enabled").notNull().default(true),
  send_order: integer("send_order").notNull().default(0),
  notes: text("notes"),
  updated_by_user_id: integer("updated_by_user_id"),
  created_at: timestamp("created_at").defaultNow().notNull(),
  updated_at: timestamp("updated_at").defaultNow().notNull(),
});

export const insertTemplateAssignmentSchema = createInsertSchema(templateAssignmentsTable).omit({
  id: true,
  created_at: true,
  updated_at: true,
});

export type TemplateAssignment = typeof templateAssignmentsTable.$inferSelect;
export type InsertTemplateAssignment = z.infer<typeof insertTemplateAssignmentSchema>;
