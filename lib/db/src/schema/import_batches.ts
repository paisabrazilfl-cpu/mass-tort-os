import {
  pgTable,
  serial,
  integer,
  varchar,
  text,
  timestamp,
  jsonb,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const importBatchesTable = pgTable("import_batches", {
  id: serial("id").primaryKey(),
  filename: text("filename").notNull(),
  status: varchar("status", { length: 20 }).notNull().default("pending"),
  total_rows: integer("total_rows").notNull().default(0),
  processed_rows: integer("processed_rows").notNull().default(0),
  success_count: integer("success_count").notNull().default(0),
  duplicate_count: integer("duplicate_count").notNull().default(0),
  error_count: integer("error_count").notNull().default(0),
  conflict_count: integer("conflict_count").notNull().default(0),
  column_mapping: jsonb("column_mapping"),
  created_by: varchar("created_by", { length: 255 }).notNull().default("system"),
  created_at: timestamp("created_at").defaultNow().notNull(),
  completed_at: timestamp("completed_at"),
});

export const importRowsTable = pgTable("import_rows", {
  id: serial("id").primaryKey(),
  batch_id: integer("batch_id").notNull(),
  row_number: integer("row_number").notNull(),
  status: varchar("status", { length: 20 }).notNull().default("pending"),
  raw_data: jsonb("raw_data").notNull(),
  lead_id: integer("lead_id"),
  dedup_match_id: integer("dedup_match_id"),
  dedup_reason: text("dedup_reason"),
  error_message: text("error_message"),
  conflict_details: jsonb("conflict_details"),
  created_at: timestamp("created_at").defaultNow().notNull(),
  processed_at: timestamp("processed_at"),
});

export const insertImportBatchSchema = createInsertSchema(importBatchesTable).omit({
  id: true,
  created_at: true,
  completed_at: true,
});

export const insertImportRowSchema = createInsertSchema(importRowsTable).omit({
  id: true,
  created_at: true,
  processed_at: true,
});

export type InsertImportBatch = z.infer<typeof insertImportBatchSchema>;
export type ImportBatch = typeof importBatchesTable.$inferSelect;
export type InsertImportRow = z.infer<typeof insertImportRowSchema>;
export type ImportRow = typeof importRowsTable.$inferSelect;
