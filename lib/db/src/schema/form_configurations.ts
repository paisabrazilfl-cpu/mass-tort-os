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
  // Lightweight public-website lead-capture form config (the "Web Forms" tab).
  // This is intentionally separate from the heavy operator intake form
  // configured by `custom_fields` / `extra_fields` etc. above. Null until an
  // admin (or the seeder) populates it.
  web_form_config: jsonb("web_form_config").$type<WebFormConfig | null>(),
  // Per-tort branding + image library for the public marketing/intake surfaces
  // (colors, fonts, and a named image asset map). Null ⇒ system default brand.
  site_profile: jsonb("site_profile").$type<SiteProfile | null>(),
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

// ─────────────────────────────────────────────────────────────────────────
// Web Forms — public, lightweight, embeddable lead-capture forms.
// Distinct from the heavy operator intake (custom_fields above).
// ─────────────────────────────────────────────────────────────────────────

export type WebFormFieldType =
  | "text"
  | "email"
  | "tel"
  | "date"
  | "number"
  | "select"
  | "radio"
  | "textarea"
  | "checkbox"
  | "state"
  | "file"
  | "signature";

export type WebFormSection = "eligibility" | "contact" | "story";

export type ShowIfOp = "eq" | "ne" | "in" | "not_in" | "lt" | "gt";

/**
 * Conditional-visibility predicate. A field carrying `show_if` is rendered (and
 * validated) only when the referenced field's current value satisfies the
 * predicate. Used to build branching, multi-step intake flows without a separate
 * rules engine.
 */
export interface ShowIfCondition {
  field: string;
  op: ShowIfOp;
  value: string | number | string[];
}

export interface WebFormField {
  key: string;
  label: string;
  type: WebFormFieldType;
  section: WebFormSection;
  required: boolean;
  placeholder?: string;
  helper_text?: string;
  options?: string[];
  max_length?: number;
  /** 1-based wizard step (multi-step intake). Absent ⇒ rendered in section order. */
  step?: number;
  /** Conditional visibility — field only shows/validates when this matches. */
  show_if?: ShowIfCondition;
  /** For `file` uploads: comma-separated accept hint, e.g. ".pdf,.jpg,image/*". */
  accept?: string;
}

export type EligibilityOp = "eq" | "ne" | "in" | "not_in" | "lt" | "gt";

export interface EligibilityRule {
  id: string;
  field: string;
  op: EligibilityOp;
  value: string | number | string[];
  message: string;
}

export interface WebFormConfig {
  enabled: boolean;
  intro_headline: string;
  intro_subhead: string;
  fields: WebFormField[];
  eligibility_rules: EligibilityRule[];
  send_confirmation_email: boolean;
  confirmation_subject: string;
  confirmation_body_html: string;
}

/**
 * Per-tort branding + image library for the public marketing/intake surfaces.
 * All fields optional — a missing value falls back to the system default brand.
 * `images` values are URLs (absolute, or app-relative like
 * `/api/brand-assets/<tort>/<file>.png`) served same-origin so they satisfy the
 * SEO pages' tight `img-src 'self'` CSP.
 */
export interface SiteProfile {
  brand_name?: string;
  colors?: {
    primary?: string;
    primary_dark?: string;
    accent?: string;
  };
  fonts?: {
    heading?: string;
    body?: string;
  };
  images?: {
    logo?: string;
    favicon?: string;
    hero?: string;
    og?: string;
    [key: string]: string | undefined;
  };
}

export const showIfConditionSchema = z.object({
  field: z.string().min(1).max(100),
  op: z.enum(["eq", "ne", "in", "not_in", "lt", "gt"]),
  value: z.union([z.string().max(500), z.number(), z.array(z.string().max(200)).max(50)]),
});

export const webFormFieldSchema = z.object({
  key: z.string().min(1).max(100).regex(/^[a-z][a-z0-9_]*$/, "key must be snake_case"),
  label: z.string().min(1).max(255),
  type: z.enum([
    "text", "email", "tel", "date", "number",
    "select", "radio", "textarea", "checkbox", "state",
    "file", "signature",
  ]),
  section: z.enum(["eligibility", "contact", "story"]),
  required: z.boolean(),
  placeholder: z.string().max(255).optional(),
  helper_text: z.string().max(500).optional(),
  options: z.array(z.string().max(200)).optional(),
  max_length: z.number().int().positive().max(10000).optional(),
  step: z.number().int().min(1).max(12).optional(),
  show_if: showIfConditionSchema.optional(),
  accept: z.string().max(200).optional(),
});

export const eligibilityRuleSchema = z.object({
  id: z.string().min(1).max(100),
  field: z.string().min(1).max(100),
  op: z.enum(["eq", "ne", "in", "not_in", "lt", "gt"]),
  value: z.union([z.string().max(500), z.number(), z.array(z.string().max(200)).max(50)]),
  message: z.string().min(1).max(500),
});

export const webFormConfigSchema = z.object({
  enabled: z.boolean(),
  intro_headline: z.string().max(255).default(""),
  intro_subhead: z.string().max(1000).default(""),
  fields: z.array(webFormFieldSchema).max(80),
  eligibility_rules: z.array(eligibilityRuleSchema).max(40),
  send_confirmation_email: z.boolean(),
  confirmation_subject: z.string().max(255),
  confirmation_body_html: z.string().max(10000),
});

export const insertFormConfigurationSchema = createInsertSchema(formConfigurationsTable).omit({
  created_at: true,
  updated_at: true,
});

export type FormConfiguration = typeof formConfigurationsTable.$inferSelect;
export type InsertFormConfiguration = z.infer<typeof insertFormConfigurationSchema>;
