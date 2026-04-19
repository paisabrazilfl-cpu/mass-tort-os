import {
  pgTable,
  varchar,
  jsonb,
  timestamp,
  integer,
  boolean,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const formConfigurationsTable = pgTable("form_configurations", {
  id: varchar("id", { length: 100 }).primaryKey(),
  label: varchar("label", { length: 255 }).notNull(),
  category: varchar("category", { length: 50 }).notNull(),
  valid_diagnoses: jsonb("valid_diagnoses").$type<string[]>().notNull().default([]),
  exposure_fields: jsonb("exposure_fields").$type<string[]>().notNull().default([]),
  extra_fields: jsonb("extra_fields").$type<string[]>().notNull().default([]),
  custom_fields: jsonb("custom_fields").$type<CustomField[]>().notNull().default([]),
  rules: jsonb("rules").$type<string[]>().notNull().default([]),
  rejection_conditions: jsonb("rejection_conditions").$type<string[]>().notNull().default([]),
  required_exposure: boolean("required_exposure").notNull().default(false),
  intro_text: varchar("intro_text", { length: 1000 }),
  active: boolean("active").notNull().default(true),
  // Decision Engine inputs
  avg_settlement_low: integer("avg_settlement_low"),
  avg_settlement_high: integer("avg_settlement_high"),
  expected_duration_months: integer("expected_duration_months"),
  mdl_status: varchar("mdl_status", { length: 30 }),
  sol_months: integer("sol_months"),
  updated_by: integer("updated_by"),
  created_at: timestamp("created_at").defaultNow().notNull(),
  updated_at: timestamp("updated_at").defaultNow().notNull(),
});

export type CustomFieldType =
  | "text"
  | "email"
  | "tel"
  | "date"
  | "number"
  | "select"
  | "textarea"
  | "checkbox";

export interface CustomField {
  key: string;
  label: string;
  type: CustomFieldType;
  required: boolean;
  placeholder?: string;
  helper_text?: string;
  options?: string[];
  max_length?: number;
}

export const customFieldSchema = z.object({
  key: z.string().min(1).max(100).regex(/^[a-z][a-z0-9_]*$/, "key must be snake_case"),
  label: z.string().min(1).max(255),
  type: z.enum(["text", "email", "tel", "date", "number", "select", "textarea", "checkbox"]),
  required: z.boolean(),
  placeholder: z.string().max(255).optional(),
  helper_text: z.string().max(500).optional(),
  options: z.array(z.string().max(100)).optional(),
  max_length: z.number().int().positive().optional(),
});

export const insertFormConfigurationSchema = createInsertSchema(formConfigurationsTable).omit({
  created_at: true,
  updated_at: true,
});

export type FormConfiguration = typeof formConfigurationsTable.$inferSelect;
export type InsertFormConfiguration = z.infer<typeof insertFormConfigurationSchema>;
