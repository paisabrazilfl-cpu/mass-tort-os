import { pgTable, serial, integer, varchar, jsonb, timestamp, index } from "drizzle-orm/pg-core";

export const leadBackgroundCheckSnapshotsTable = pgTable(
  "lead_background_check_snapshots",
  {
    id: serial("id").primaryKey(),
    lead_id: integer("lead_id").notNull(),
    version: varchar("version", { length: 50 }).notNull(),
    final_status: varchar("final_status", { length: 20 }).notNull(),
    overall_score: integer("overall_score").notNull(),
    result: jsonb("result").notNull(),
    created_at: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => ({
    leadIdIdx: index("lead_background_check_snapshots_lead_id_idx").on(t.lead_id),
    leadIdCreatedIdx: index("lead_background_check_snapshots_lead_id_created_at_idx").on(
      t.lead_id,
      t.created_at,
    ),
  }),
);

export type LeadBackgroundCheckSnapshot = typeof leadBackgroundCheckSnapshotsTable.$inferSelect;
export type LeadBackgroundCheckSnapshotInsert = typeof leadBackgroundCheckSnapshotsTable.$inferInsert;
