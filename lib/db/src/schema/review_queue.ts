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

// review_queue items are firm-owned: an OCR failure for firm A's lead must
// not appear in firm B's review queue. Earlier versions of this table had
// no firm_id at all, so GET /api/review-queue returned every firm's items
// to any caller with REVIEW_QUEUE_VIEW. firm_id is nullable on the schema
// for backward compatibility with legacy rows, but the routes now require
// it and strict-scope every query; scripts/backfill-review-queue-firm-id.sql
// derives firm_id for legacy rows from their parent entity (lead/case).
export const reviewQueueTable = pgTable("review_queue", {
  id: serial("id").primaryKey(),
  firm_id: integer("firm_id"),
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
  firmResolutionIdx: index("review_queue_firm_resolution_idx").on(t.firm_id, t.resolution, t.created_at),
}));

export const insertReviewQueueSchema = createInsertSchema(reviewQueueTable).omit({
  id: true,
  created_at: true,
});

export type InsertReviewQueue = z.infer<typeof insertReviewQueueSchema>;
export type ReviewQueueItem = typeof reviewQueueTable.$inferSelect;
