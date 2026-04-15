import {
  pgTable,
  serial,
  integer,
  varchar,
  text,
  boolean,
  timestamp,
  jsonb,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const imageObjectsTable = pgTable("image_objects", {
  id: serial("id").primaryKey(),
  original_filename: text("original_filename").notNull(),
  mime_type: varchar("mime_type", { length: 100 }).notNull(),
  file_size: integer("file_size").notNull(),
  width: integer("width"),
  height: integer("height"),
  source_type: varchar("source_type", { length: 50 }).notNull().default("upload"),
  vault_path: text("vault_path").notNull(),
  checksum_sha256: varchar("checksum_sha256", { length: 64 }).notNull(),
  ocr_status: varchar("ocr_status", { length: 20 }).notNull().default("pending"),
  ocr_text: text("ocr_text"),
  ocr_confidence: integer("ocr_confidence"),
  ocr_extracted_fields: jsonb("ocr_extracted_fields"),
  lead_id: integer("lead_id"),
  document_id: integer("document_id"),
  fax_result_id: integer("fax_result_id"),
  case_id: varchar("case_id", { length: 100 }),
  is_sensitive: boolean("is_sensitive").notNull().default(true),
  access_classification: varchar("access_classification", { length: 20 }).notNull().default("confidential"),
  retention_days: integer("retention_days").default(2555),
  metadata: jsonb("metadata"),
  created_by: varchar("created_by", { length: 255 }).notNull().default("system"),
  created_at: timestamp("created_at").defaultNow().notNull(),
  updated_at: timestamp("updated_at").defaultNow().notNull(),
});

export const insertImageObjectSchema = createInsertSchema(imageObjectsTable).omit({
  id: true,
  created_at: true,
  updated_at: true,
});

export type InsertImageObject = z.infer<typeof insertImageObjectSchema>;
export type ImageObject = typeof imageObjectsTable.$inferSelect;
