import {
  pgTable,
  serial,
  varchar,
  jsonb,
  text,
  timestamp,
  integer,
  index,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const jobQueueTable = pgTable("job_queue", {
  id: serial("id").primaryKey(),
  job_type: varchar("job_type", { length: 50 }).notNull(),
  payload: jsonb("payload").notNull(),
  // Status lifecycle:
  //   pending -> processing -> done             (happy path)
  //   pending -> processing -> pending          (retryable failure, backed off via next_attempt_at)
  //   pending -> processing -> dead_letter      (retries exhausted OR non-retryable failure)
  //   pending -> processing -> failed           (legacy terminal — kept for backwards compat with old rows)
  status: varchar("status", { length: 20 }).notNull().default("pending"),
  error: text("error"),
  // NOTE: `attempts` is the original misdeclared serial column. It assigns
  // its value once at INSERT and never increments, so it is NOT a retry
  // counter. We keep it in place so existing rows aren't disturbed and use
  // the new `retry_count` column below instead.
  attempts: serial("attempts"),
  // Real retry counter — incremented each time markJobFailed re-queues a
  // retryable failure. Capped at MAX_RETRIES (see lib/queue.ts).
  retry_count: integer("retry_count").notNull().default(0),
  // When the job is eligible to be claimed again. NULL means "claim
  // immediately" (the normal case for fresh jobs). Set to a future
  // timestamp on retry to implement exponential backoff.
  next_attempt_at: timestamp("next_attempt_at"),
  created_at: timestamp("created_at").defaultNow().notNull(),
  started_at: timestamp("started_at"),
  completed_at: timestamp("completed_at"),
}, (t) => ({
  // Backwards-compat indexes from the perf audit
  statusCreatedIdx: index("job_queue_status_created_at_idx").on(t.status, t.created_at),
  statusStartedIdx: index("job_queue_status_started_at_idx").on(t.status, t.started_at),
  jobTypeStatusIdx: index("job_queue_job_type_status_idx").on(t.job_type, t.status),
  // Composite that matches the actual claim query: pending jobs whose
  // next_attempt_at is past, ordered by created_at.
  claimReadyIdx: index("job_queue_claim_ready_idx").on(t.status, t.next_attempt_at, t.created_at),
}));

export const insertJobSchema = createInsertSchema(jobQueueTable).omit({
  id: true,
  attempts: true,
  created_at: true,
  started_at: true,
  completed_at: true,
});

export type InsertJob = z.infer<typeof insertJobSchema>;
export type Job = typeof jobQueueTable.$inferSelect;
