import {
  pgTable,
  serial,
  varchar,
  text,
  jsonb,
  timestamp,
  integer,
  index,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const reviewQueueTable = pgTable("review_queue", {
  id: serial("id").primaryKey(),
  entity_type: varchar("entity_type", { length: 50 }).notNull(),
  entity_id: varchar("entity_id", { length: 100 }).notNull(),
  conflict_type: varchar("conflict_type", { length: 50 }).notNull(),
  severity: varchar("severity", { length: 20 }).notNull().default("medium"),
  failsafe_mode: varchar("failsafe_mode", { length: 20 }).notNull(),
  source_module: varchar("source_module", { length: 100 }).notNull(),
  summary: text("summary").notNull(),
  details: jsonb("details"),
  resolution: varchar("resolution", { length: 20 }).default("pending"),
  resolution_notes: text("resolution_notes"),
  resolved_by: varchar("resolved_by", { length: 100 }),
  resolved_at: timestamp("resolved_at"),
  retry_count: integer("retry_count").notNull().default(0),
  created_at: timestamp("created_at").defaultNow().notNull(),
}, (t) => ({
  resolutionCreatedIdx: index("review_queue_resolution_created_at_idx").on(t.resolution, t.created_at),
  entityIdx: index("review_queue_entity_idx").on(t.entity_type, t.entity_id),
  createdAtIdx: index("review_queue_created_at_idx").on(t.created_at),
}));

export const insertReviewQueueSchema = createInsertSchema(reviewQueueTable).omit({
  id: true,
  created_at: true,
});

export type InsertReviewQueue = z.infer<typeof insertReviewQueueSchema>;
export type ReviewQueueItem = typeof reviewQueueTable.$inferSelect;
