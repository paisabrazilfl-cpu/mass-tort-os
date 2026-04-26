import {
  pgTable,
  serial,
  varchar,
  jsonb,
  real,
  timestamp,
  index,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { casesTable } from "./cases";

export const analysisTable = pgTable("analysis", {
  id: serial("id").primaryKey(),
  case_id: varchar("case_id", { length: 36 })
    .notNull()
    .references(() => casesTable.id, { onDelete: "cascade" }),
  features: jsonb("features"),
  score: real("score"),
  ai_model: varchar("ai_model", { length: 100 }),
  raw_text_length: real("raw_text_length"),
  created_at: timestamp("created_at").defaultNow().notNull(),
}, (t) => ({
  caseCreatedIdx: index("analysis_case_created_at_idx").on(t.case_id, t.created_at),
}));

export const insertAnalysisSchema = createInsertSchema(analysisTable).omit({
  id: true,
  created_at: true,
});

export type InsertAnalysis = z.infer<typeof insertAnalysisSchema>;
export type Analysis = typeof analysisTable.$inferSelect;
