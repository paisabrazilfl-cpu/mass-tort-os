import {
  pgTable,
  serial,
  integer,
  varchar,
  text,
  boolean,
  jsonb,
  timestamp,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

/**
 * Append-only audit trail for the Intake-to-Med-Recs deterministic pipeline
 * state machine (see artifacts/api-server/src/lib/pipeline/state-machine.ts).
 *
 * Every attempted transition writes exactly one row here — whether it was
 * applied, rejected as illegal, or suppressed as a duplicate. `leads.pipeline_status`
 * holds the current state; this table is the full ordered history that powers
 * the pipeline timeline and lets an operator see WHY a lead is where it is.
 *
 * The table is LEAD-scoped (lead_id), not firm-scoped: a pipeline event belongs
 * to its lead, and tenancy is enforced on the READ side by scoping access to the
 * lead itself (routes/pipeline.ts loadLeadScoped). Carrying a firm_id here was
 * removed by owner decision — it added a non-null/nullable tenancy ambiguity for
 * firm-less public-intake leads without buying any access-control that the
 * lead-level scoping does not already provide.
 *
 * event_key is the provider-supplied event id (or a deterministic synthetic
 * key) used for idempotency. The unique index means a webhook redelivery with
 * the same event_key can never advance the pipeline twice. Postgres treats
 * NULLs as distinct, so internal transitions without an external event id are
 * free to omit it.
 */
export const pipelineEventsTable = pgTable(
  "pipeline_events",
  {
    id: serial("id").primaryKey(),
    lead_id: integer("lead_id").notNull(),
    from_status: varchar("from_status", { length: 30 }),
    to_status: varchar("to_status", { length: 30 }).notNull(),
    trigger: varchar("trigger", { length: 60 }).notNull(),
    // "applied" = pipeline_status actually moved. false for illegal transition
    // attempts (logged but not applied) and duplicate-suppressed events.
    applied: boolean("applied").notNull().default(true),
    outcome: varchar("outcome", { length: 30 }).notNull().default("applied"),
    event_key: varchar("event_key", { length: 255 }),
    note: text("note"),
    payload: jsonb("payload"),
    source: varchar("source", { length: 60 }).notNull().default("system"),
    created_by_user_id: integer("created_by_user_id"),
    created_at: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => ({
    leadIdx: index("pipeline_events_lead_id_idx").on(t.lead_id),
    leadCreatedIdx: index("pipeline_events_lead_created_idx").on(t.lead_id, t.created_at),
    eventKeyIdx: uniqueIndex("pipeline_events_event_key_idx").on(t.event_key),
  }),
);

export const insertPipelineEventSchema = createInsertSchema(pipelineEventsTable).omit({
  id: true,
  created_at: true,
});

export type InsertPipelineEvent = z.infer<typeof insertPipelineEventSchema>;
export type PipelineEvent = typeof pipelineEventsTable.$inferSelect;
