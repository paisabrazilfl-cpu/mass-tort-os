import { pgTable, serial, varchar, text, timestamp, boolean, integer, jsonb } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

/**
 * Reusable document template uploaded once and used many times.
 * source = "pdf"  → static uploaded PDF, sent as-is (with merge fields if specified)
 * source = "ai"   → drafted on-demand via drafting-ai.ts using the lead context
 */
export const documentTemplatesTable = pgTable("document_templates", {
  id: serial("id").primaryKey(),
  name: varchar("name", { length: 255 }).notNull(),
  template_type: varchar("template_type", { length: 50 }).notNull(),
  description: text("description"),
  source: varchar("source", { length: 20 }).notNull().default("pdf"),
  storage_path: text("storage_path"),
  ai_prompt: text("ai_prompt"),
  requires_signature: boolean("requires_signature").notNull().default(true),
  signer_role: varchar("signer_role", { length: 50 }).notNull().default("lead"),
  merge_fields: jsonb("merge_fields").$type<string[]>().notNull().default([]),
  delivery_subject: varchar("delivery_subject", { length: 255 }),
  delivery_message: text("delivery_message"),
  triggers_med_records_request: boolean("triggers_med_records_request").notNull().default(false),
  active: boolean("active").notNull().default(true),
  uploaded_by_user_id: integer("uploaded_by_user_id"),
  created_at: timestamp("created_at").defaultNow().notNull(),
  updated_at: timestamp("updated_at").defaultNow().notNull(),
});

export const insertDocumentTemplateSchema = createInsertSchema(documentTemplatesTable).omit({
  id: true,
  created_at: true,
  updated_at: true,
});

export type DocumentTemplate = typeof documentTemplatesTable.$inferSelect;
export type InsertDocumentTemplate = z.infer<typeof insertDocumentTemplateSchema>;
