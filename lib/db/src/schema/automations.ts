import { pgTable, serial, varchar, text, timestamp, integer, boolean, jsonb, index } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const automationWorkflowsTable = pgTable(
  "automation_workflows",
  {
    id: serial("id").primaryKey(),
    firm_id: integer("firm_id"),
    name: varchar("name", { length: 200 }).notNull(),
    description: text("description"),
    graph: jsonb("graph").$type<{ nodes: any[]; edges: any[] }>().notNull().default({ nodes: [], edges: [] }),
    enabled: boolean("enabled").notNull().default(false),
    trigger_type: varchar("trigger_type", { length: 40 }).notNull().default("manual"),
    trigger_config: jsonb("trigger_config").$type<Record<string, unknown>>().notNull().default({}),
    tags: jsonb("tags").$type<string[]>().notNull().default([]),
    created_by_user_id: integer("created_by_user_id"),
    created_at: timestamp("created_at").defaultNow().notNull(),
    updated_at: timestamp("updated_at").defaultNow().notNull(),
  },
  (t) => ({
    firmIdx: index("automation_workflows_firm_idx").on(t.firm_id, t.updated_at),
    triggerIdx: index("automation_workflows_trigger_idx").on(t.trigger_type, t.enabled),
  }),
);

export const automationRunsTable = pgTable(
  "automation_runs",
  {
    id: serial("id").primaryKey(),
    workflow_id: integer("workflow_id").notNull(),
    firm_id: integer("firm_id"),
    status: varchar("status", { length: 20 }).notNull().default("pending"),
    trigger_source: varchar("trigger_source", { length: 40 }).notNull().default("manual"),
    input: jsonb("input").$type<Record<string, unknown>>().notNull().default({}),
    output: jsonb("output").$type<Record<string, unknown>>(),
    step_log: jsonb("step_log").$type<any[]>().notNull().default([]),
    error: text("error"),
    started_by_user_id: integer("started_by_user_id"),
    started_at: timestamp("started_at").defaultNow().notNull(),
    completed_at: timestamp("completed_at"),
  },
  (t) => ({
    workflowIdx: index("automation_runs_workflow_idx").on(t.workflow_id, t.started_at),
    firmStatusIdx: index("automation_runs_firm_status_idx").on(t.firm_id, t.status, t.started_at),
  }),
);

export const insertAutomationWorkflowSchema = createInsertSchema(automationWorkflowsTable).omit({
  id: true,
  created_at: true,
  updated_at: true,
});
export type AutomationWorkflow = typeof automationWorkflowsTable.$inferSelect;
export type InsertAutomationWorkflow = z.infer<typeof insertAutomationWorkflowSchema>;
export type AutomationRun = typeof automationRunsTable.$inferSelect;
