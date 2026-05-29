import { pgTable, serial, varchar, text, timestamp, index } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

/**
 * Per-tort Vapi voice agents (Task #90).
 *
 * One row per tort id (from TORT_REGISTRY) mapping that tort to its
 * dedicated Vapi assistant plus sync metadata so we can detect drift
 * (prompt_fingerprint vs the currently-generated prompt) and re-sync.
 *
 * status:
 *   "not_provisioned" — never pushed to Vapi (no row usually exists yet)
 *   "active"          — assistant created/updated in Vapi successfully
 *   "error"           — last provision attempt failed (see last_error)
 */
export const tortVoiceAgentsTable = pgTable(
  "tort_voice_agents",
  {
    id: serial("id").primaryKey(),
    tort_id: varchar("tort_id", { length: 80 }).notNull().unique(),
    tort_label: varchar("tort_label", { length: 200 }).notNull(),
    vapi_assistant_id: varchar("vapi_assistant_id", { length: 100 }),
    status: varchar("status", { length: 20 }).notNull().default("not_provisioned"),
    prompt_fingerprint: varchar("prompt_fingerprint", { length: 64 }),
    last_synced_at: timestamp("last_synced_at", { withTimezone: true }),
    last_error: text("last_error"),
    created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updated_at: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => ({
    tortIdx: index("tort_voice_agents_tort_id_idx").on(t.tort_id),
    statusIdx: index("tort_voice_agents_status_idx").on(t.status),
  }),
);

export const insertTortVoiceAgentSchema = createInsertSchema(tortVoiceAgentsTable).omit({
  id: true,
  created_at: true,
  updated_at: true,
});
export type InsertTortVoiceAgent = z.infer<typeof insertTortVoiceAgentSchema>;
export type TortVoiceAgent = typeof tortVoiceAgentsTable.$inferSelect;
