import {
  pgTable,
  serial,
  integer,
  varchar,
  text,
  boolean,
  timestamp,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { leadsTable } from "./leads";

export const documentsTable = pgTable("documents", {
  id: serial("id").primaryKey(),
  lead_id: integer("lead_id")
    .notNull()
    .references(() => leadsTable.id, { onDelete: "cascade" }),
  document_type: varchar("document_type", { length: 50 }).notNull(),
  file_name: varchar("file_name", { length: 255 }).notNull(),
  file_url: text("file_url"),
  signed: boolean("signed").notNull().default(false),
  signed_at: timestamp("signed_at"),
  notes: text("notes"),
  created_at: timestamp("created_at").defaultNow().notNull(),
});

export const insertDocumentSchema = createInsertSchema(documentsTable).omit({
  id: true,
  created_at: true,
});

export type InsertDocument = z.infer<typeof insertDocumentSchema>;
export type Document = typeof documentsTable.$inferSelect;
