import { pgTable, serial, text, timestamp, integer, boolean, index } from "drizzle-orm/pg-core";
import { firmsTable } from "./firms";
import { usersTable } from "./users";

export const selfHealSessionsTable = pgTable("self_heal_sessions", {
  id: serial("id").primaryKey(),
  firm_id: integer("firm_id").notNull().references(() => firmsTable.id),
  created_by_user_id: integer("created_by_user_id").notNull().references(() => usersTable.id),
  jules_session_id: text("jules_session_id").unique(),
  jules_session_name: text("jules_session_name"),
  source_name: text("source_name").notNull(),
  starting_branch: text("starting_branch").notNull().default("main"),
  title: text("title").notNull(),
  prompt: text("prompt").notNull(),
  automation_mode: text("automation_mode").notNull().default("AUTO_CREATE_PR"),
  require_plan_approval: boolean("require_plan_approval").notNull().default(false),
  status: text("status").notNull().default("pending"),
  pr_url: text("pr_url"),
  pr_title: text("pr_title"),
  last_error: text("last_error"),
  last_synced_at: timestamp("last_synced_at"),
  created_at: timestamp("created_at").defaultNow().notNull(),
  updated_at: timestamp("updated_at").defaultNow().notNull(),
}, (t) => ({
  firmIdx: index("self_heal_sessions_firm_idx").on(t.firm_id, t.created_at),
  julesIdx: index("self_heal_sessions_jules_idx").on(t.jules_session_id),
  statusIdx: index("self_heal_sessions_status_idx").on(t.status),
}));
