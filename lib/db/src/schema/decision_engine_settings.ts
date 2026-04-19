import { pgTable, integer, decimal, boolean, timestamp } from "drizzle-orm/pg-core";

// Singleton row (id = 1) holding global Decision Engine thresholds.
export const decisionEngineSettingsTable = pgTable("decision_engine_settings", {
  id: integer("id").primaryKey().default(1),
  concentration_warning_pct: integer("concentration_warning_pct").notNull().default(40),
  ruin_auto_flag: boolean("ruin_auto_flag").notNull().default(false),
  default_attorney_hourly_cost: decimal("default_attorney_hourly_cost", { precision: 8, scale: 2 }).notNull().default("250.00"),
  default_hours_per_lead: decimal("default_hours_per_lead", { precision: 6, scale: 2 }).notNull().default("8.00"),
  convex_ratio_threshold: decimal("convex_ratio_threshold", { precision: 6, scale: 2 }).notNull().default("5.00"),
  concave_ratio_threshold: decimal("concave_ratio_threshold", { precision: 6, scale: 2 }).notNull().default("1.50"),
  updated_at: timestamp("updated_at").defaultNow().notNull(),
});

export type DecisionEngineSettings = typeof decisionEngineSettingsTable.$inferSelect;
