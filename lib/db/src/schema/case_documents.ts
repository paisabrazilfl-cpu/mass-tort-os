import {
  pgTable,
  serial,
  varchar,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { casesTable } from "./cases";

export const caseDocumentsTable = pgTable("case_documents", {
  id: serial("id").primaryKey(),
  case_id: varchar("case_id", { length: 36 })
    .notNull()
    .references(() => casesTable.id, { onDelete: "cascade" }),
  path: text("path").notNull(),
  file_hash: varchar("file_hash", { length: 64 }),
  file_name: varchar("file_name", { length: 255 }).notNull(),
  content_type: varchar("content_type", { length: 100 }),
  size_bytes: serial("size_bytes"),
  created_at: timestamp("created_at").defaultNow().notNull(),
});

export const insertCaseDocumentSchema = createInsertSchema(caseDocumentsTable).omit({
  id: true,
  size_bytes: true,
  created_at: true,
});

export type InsertCaseDocument = z.infer<typeof insertCaseDocumentSchema>;
export type CaseDocument = typeof caseDocumentsTable.$inferSelect;
