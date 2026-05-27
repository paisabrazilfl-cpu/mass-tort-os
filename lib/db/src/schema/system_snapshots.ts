import {
  pgTable,
  serial,
  integer,
  text,
  timestamp,
  jsonb,
  index,
} from "drizzle-orm/pg-core";

export const systemSnapshotsTable = pgTable("system_snapshots", {
  id: serial("id").primaryKey(),
  firm_id: integer("firm_id").notNull(),
  created_by_user_id: integer("created_by_user_id"),
  name: text("name").notNull(),
  notes: text("notes"),
  payload: jsonb("payload").notNull(),
  payload_sha256: text("payload_sha256").notNull(),
  byte_size: integer("byte_size").notNull(),
  summary: jsonb("summary").$type<Record<string, number>>().notNull().default({}),
  created_at: timestamp("created_at").defaultNow().notNull(),
}, (t) => ({
  firmIdx: index("system_snapshots_firm_id_idx").on(t.firm_id),
}));

export type SystemSnapshot = typeof systemSnapshotsTable.$inferSelect;
