import {
  pgTable,
  serial,
  integer,
  varchar,
  text,
  timestamp,
  index,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

/**
 * Append-only event log of disposition decisions ("go", "hold", "abort",
 * "human_review", "auto_qualified", "auto_rejected", etc) made by the
 * Vapi tool callbacks, the decision engine, or a human reviewer. The
 * leads.status column is the most-recent state; this table is the audit
 * trail that powers the timeline view.
 */
export const leadDispositionsTable = pgTable(
  "lead_dispositions",
  {
    id: serial("id").primaryKey(),
    firm_id: integer("firm_id"),
    lead_id: integer("lead_id").notNull(),
    disposition: varchar("disposition", { length: 30 }).notNull(),
    reason: text("reason"),
    source: varchar("source", { length: 30 }).notNull().default("system"),
    created_by_user_id: integer("created_by_user_id"),
    created_at: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => ({
    leadIdx: index("lead_dispositions_lead_id_idx").on(t.lead_id),
    firmIdx: index("lead_dispositions_firm_id_idx").on(t.firm_id),
    leadCreatedIdx: index("lead_dispositions_lead_created_idx").on(t.lead_id, t.created_at),
  }),
);

export const insertLeadDispositionSchema = createInsertSchema(leadDispositionsTable).omit({
  id: true,
  created_at: true,
});

export type InsertLeadDisposition = z.infer<typeof insertLeadDispositionSchema>;
export type LeadDisposition = typeof leadDispositionsTable.$inferSelect;
