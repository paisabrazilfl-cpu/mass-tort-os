import { pgTable, serial, varchar, text, timestamp, integer, boolean, jsonb } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

/**
 * Singleton-style settings for the auto-document workflow.
 * One row per "scope" — scope="global" is the default; scope="buyer:<id>" overrides per buyer.
 * Buyer-level rows take precedence; missing fields fall through to global.
 */
export const workflowSettingsTable = pgTable("workflow_settings", {
  id: serial("id").primaryKey(),
  scope: varchar("scope", { length: 100 }).notNull().unique(),
  esign_provider_integration_id: integer("esign_provider_integration_id"),
  fax_provider_integration_id: integer("fax_provider_integration_id"),
  email_provider_integration_id: integer("email_provider_integration_id"),
  default_email_from_name: varchar("default_email_from_name", { length: 255 }),
  default_email_from_address: varchar("default_email_from_address", { length: 255 }),
  default_fax_from_number: varchar("default_fax_from_number", { length: 50 }),
  auto_send_on_approval: boolean("auto_send_on_approval").notNull().default(true),
  auto_fax_doctor_on_signed_hipaa: boolean("auto_fax_doctor_on_signed_hipaa").notNull().default(true),
  esign_resend_after_days: integer("esign_resend_after_days").notNull().default(3),
  esign_expire_after_days: integer("esign_expire_after_days").notNull().default(14),
  max_send_retries: integer("max_send_retries").notNull().default(3),
  notify_on_failure_email: varchar("notify_on_failure_email", { length: 255 }),
  med_records_cover_letter_template_id: integer("med_records_cover_letter_template_id"),
  metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
  notes: text("notes"),
  updated_by_user_id: integer("updated_by_user_id"),
  created_at: timestamp("created_at").defaultNow().notNull(),
  updated_at: timestamp("updated_at").defaultNow().notNull(),
});

export const insertWorkflowSettingsSchema = createInsertSchema(workflowSettingsTable).omit({
  id: true,
  created_at: true,
  updated_at: true,
});

export type WorkflowSettings = typeof workflowSettingsTable.$inferSelect;
export type InsertWorkflowSettings = z.infer<typeof insertWorkflowSettingsSchema>;
