import { pgTable, serial, integer, text, jsonb, timestamp, index } from "drizzle-orm/pg-core";

export const systemSnapshotsTable = pgTable(
  "system_snapshots",
  {
    id: serial("id").primaryKey(),
    firm_id: integer("firm_id").notNull(),
    created_by_user_id: integer("created_by_user_id").notNull(),
    name: text("name").notNull(),
    payload: jsonb("payload").notNull(),
    payload_sha256: text("payload_sha256").notNull(),
    byte_size: integer("byte_size").notNull(),
    summary: jsonb("summary").$type<Record<string, unknown>>().notNull().default({}),
    notes: text("notes"),
    created_at: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [index("system_snapshots_firm_created_idx").on(t.firm_id, t.created_at)],
);
