import {
  pgTable,
  serial,
  integer,
  varchar,
  text,
  jsonb,
  timestamp,
  index,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

/**
 * Inbound/outbound voice calls handled by the Vapi adapter. Each row is
 * one call. Transcript and provider events live in JSONB so the UI can
 * stream them without a join. `intake_result` mirrors the AI-extracted
 * facts from the call so a paralegal can see them next to the player.
 *
 * No FK to firms/leads enforced — both columns are nullable so a call
 * that never resolves to a lead (wrong number, hangup) still persists.
 */
export const callLogsTable = pgTable(
  "call_logs",
  {
    id: serial("id").primaryKey(),
    firm_id: integer("firm_id"),
    lead_id: integer("lead_id"),
    vapi_call_id: varchar("vapi_call_id", { length: 100 }),
    // Which voice assistant placed/handled this call, and the tort whose
    // dedicated agent it belongs to. Recorded for outbound calls so the UI
    // and audits can show that a lead was dialed with its tort's agent.
    vapi_assistant_id: varchar("vapi_assistant_id", { length: 100 }),
    tort_type: varchar("tort_type", { length: 100 }),
    direction: varchar("direction", { length: 10 }).notNull().default("inbound"),
    from_number: varchar("from_number", { length: 32 }),
    to_number: varchar("to_number", { length: 32 }),
    status: varchar("status", { length: 30 }).notNull().default("queued"),
    started_at: timestamp("started_at"),
    ended_at: timestamp("ended_at"),
    duration_seconds: integer("duration_seconds"),
    recording_url: text("recording_url"),
    transcript: jsonb("transcript").$type<unknown[]>().notNull().default([]),
    intake_result: jsonb("intake_result").$type<Record<string, unknown>>(),
    events: jsonb("events").$type<unknown[]>().notNull().default([]),
    error: text("error"),
    created_at: timestamp("created_at").defaultNow().notNull(),
    updated_at: timestamp("updated_at").defaultNow().notNull(),
  },
  (t) => ({
    vapiCallIdIdx: index("call_logs_vapi_call_id_idx").on(t.vapi_call_id),
    firmIdx: index("call_logs_firm_id_idx").on(t.firm_id),
    leadIdx: index("call_logs_lead_id_idx").on(t.lead_id),
    statusCreatedIdx: index("call_logs_status_created_at_idx").on(t.status, t.created_at),
  }),
);

export const insertCallLogSchema = createInsertSchema(callLogsTable).omit({
  id: true,
  created_at: true,
  updated_at: true,
});

export type InsertCallLog = z.infer<typeof insertCallLogSchema>;
export type CallLog = typeof callLogsTable.$inferSelect;
