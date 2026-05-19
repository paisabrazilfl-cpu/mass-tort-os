import {
  pgTable,
  varchar,
  jsonb,
  timestamp,
  integer,
  index,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const casesTable = pgTable("cases", {
  id: varchar("id", { length: 36 }).primaryKey(),
  data: jsonb("data"),
  status: varchar("status", { length: 50 }).notNull().default("open"),
  // RBAC ownership columns (Task #10).
  // `created_by_user_id` is NOT NULL post-Task #22 backfill. The viewer-only
  // ownership filter (created_by = me OR assigned_to = me) requires every row
  // to declare an owner; legacy NULL rows would silently 403 to viewers.
  // The backfill (`scripts/backfill-case-ownership.ts`) derives the owner from
  // the earliest audit_log entry when possible and falls back to a designated
  // "system" admin user. The `create_case` worker writes the live req.user.id.
  // `assigned_to` is intentionally NOT backfilled and stays nullable. The
  // codebase has no workflow that records who a case was assigned to at
  // any point in history, so there is no reliable signal to derive the
  // value from. Most cases are unassigned at intake and acquire an
  // assignee later via a still-to-be-built assignment flow (filed as a
  // follow-up task; see Task #22 commit message for context). Until that
  // flow exists, assignment-based viewer access is opt-in by row, not by
  // backfill.
  created_by_user_id: integer("created_by_user_id").notNull(),
  assigned_to: integer("assigned_to"),
  firm_id: integer("firm_id"),
  created_at: timestamp("created_at").defaultNow().notNull(),
  updated_at: timestamp("updated_at").defaultNow().notNull(),
}, (t) => ({
  // Indexes that back the viewer ownership filter on GET /api/cases. The
  // route does `WHERE created_by_user_id = $me OR assigned_to = $me` and
  // Postgres will BitmapOr two btree lookups, so each column gets its own
  // index. Mirrors the lead-table convention (`leads_created_by_user_id_idx`,
  // `leads_assigned_to_idx`).
  createdByIdx: index("cases_created_by_user_id_idx").on(t.created_by_user_id),
  assignedIdx: index("cases_assigned_to_idx").on(t.assigned_to),
  firmIdx: index("cases_firm_id_idx").on(t.firm_id),
}));

export const insertCaseSchema = createInsertSchema(casesTable).omit({
  created_at: true,
  updated_at: true,
});

export type InsertCase = z.infer<typeof insertCaseSchema>;
export type Case = typeof casesTable.$inferSelect;
