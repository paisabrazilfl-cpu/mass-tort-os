import {
  pgTable,
  serial,
  integer,
  text,
  real,
  timestamp,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const faxResultsTable = pgTable("fax_results", {
  id: serial("id").primaryKey(),
  job_id: integer("job_id"),
  source_file: text("source_file").notNull(),
  vault_path: text("vault_path").notNull(),
  rx_number: text("rx_number").default("").notNull(),
  drug_name: text("drug_name").default("").notNull(),
  fill_date: text("fill_date").default("").notNull(),
  quantity: text("quantity").default("").notNull(),
  confidence: real("confidence").default(0).notNull(),
  raw_text: text("raw_text").default("").notNull(),
  status: text("status").default("pending").notNull(),
  error: text("error"),
  created_at: timestamp("created_at").defaultNow().notNull(),
  processed_at: timestamp("processed_at"),
});

export const insertFaxResultSchema = createInsertSchema(faxResultsTable).omit({
  id: true,
  created_at: true,
});

export type InsertFaxResult = z.infer<typeof insertFaxResultSchema>;
export type FaxResult = typeof faxResultsTable.$inferSelect;
