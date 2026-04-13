import {
  pgTable,
  serial,
  varchar,
  jsonb,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const jobQueueTable = pgTable("job_queue", {
  id: serial("id").primaryKey(),
  job_type: varchar("job_type", { length: 50 }).notNull(),
  payload: jsonb("payload").notNull(),
  status: varchar("status", { length: 20 }).notNull().default("pending"),
  error: text("error"),
  attempts: serial("attempts"),
  created_at: timestamp("created_at").defaultNow().notNull(),
  started_at: timestamp("started_at"),
  completed_at: timestamp("completed_at"),
});

export const insertJobSchema = createInsertSchema(jobQueueTable).omit({
  id: true,
  attempts: true,
  created_at: true,
  started_at: true,
  completed_at: true,
});

export type InsertJob = z.infer<typeof insertJobSchema>;
export type Job = typeof jobQueueTable.$inferSelect;
