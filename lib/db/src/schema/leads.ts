import {
  pgTable,
  serial,
  integer,
  varchar,
  text,
  boolean,
  decimal,
  timestamp,
  date,
  jsonb,
  index,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const leadsTable = pgTable("leads", {
  id: serial("id").primaryKey(),
  name: varchar("name", { length: 255 }).notNull(),
  email: varchar("email", { length: 255 }),
  phone: text("phone"),
  tort_type: varchar("tort_type", { length: 100 }).notNull(),
  exposure_start: date("exposure_start"),
  exposure_end: date("exposure_end"),
  diagnosis_confirmed: boolean("diagnosis_confirmed").notNull().default(false),
  diagnosis_type: varchar("diagnosis_type", { length: 255 }),
  was_at_location: boolean("was_at_location").notNull().default(false),
  location_name: varchar("location_name", { length: 255 }),
  status: varchar("status", { length: 20 }).notNull().default("new"),
  rejection_reason: text("rejection_reason"),
  notes: text("notes"),
  ad_spend: decimal("ad_spend", { precision: 10, scale: 2 }),
  source: varchar("source", { length: 100 }),
  assigned_to: integer("assigned_to"),
  routing: varchar("routing", { length: 20 }).default("cold"),

  first_name: varchar("first_name", { length: 255 }),
  last_name: varchar("last_name", { length: 255 }),
  date_of_birth: text("date_of_birth"),
  street_address: text("street_address"),
  city: varchar("city", { length: 100 }),
  state: varchar("state", { length: 2 }),
  zip: varchar("zip", { length: 10 }),
  phone_primary: text("phone_primary"),
  last_4_ssn: text("last_4_ssn"),

  diagnosis: text("diagnosis"),
  diagnosis_date: text("diagnosis_date"),

  physician_first_name: varchar("physician_first_name", { length: 255 }),
  physician_last_name: varchar("physician_last_name", { length: 255 }),
  physician_full_address: text("physician_full_address"),
  physician_contact_info: text("physician_contact_info"),

  hospital_name: varchar("hospital_name", { length: 500 }),
  hospital_fax: varchar("hospital_fax", { length: 50 }),
  hospital_contact_info: text("hospital_contact_info"),

  tcpa_consent: boolean("tcpa_consent").default(false),
  trustedform_cert_url: text("trustedform_cert_url"),
  trustedform_ping_url: text("trustedform_ping_url"),
  trustedform_cert_token: text("trustedform_cert_token"),
  trustedform_ip: varchar("trustedform_ip", { length: 45 }),
  trustedform_user_agent: text("trustedform_user_agent"),
  trustedform_timestamp: timestamp("trustedform_timestamp"),

  medications: text("medications"),
  npi_verified: boolean("npi_verified"),
  npi_number: varchar("npi_number", { length: 10 }),
  physician_taxonomy: varchar("physician_taxonomy", { length: 255 }),
  fraud_score: integer("fraud_score"),
  fraud_status: varchar("fraud_status", { length: 20 }),
  fraud_indicators: text("fraud_indicators"),

  email_validation_status: varchar("email_validation_status", { length: 20 }),
  address_validation_status: varchar("address_validation_status", { length: 20 }),
  background_check_status: varchar("background_check_status", { length: 20 }),
  background_check_data: text("background_check_data"),

  vendor_id: integer("vendor_id"),
  law_firm: varchar("law_firm", { length: 255 }),
  client_id: varchar("client_id", { length: 100 }),
  buyer_id: integer("buyer_id"),
  created_by_user_id: integer("created_by_user_id"),

  // Single-firm shell for MVI; nullable for legacy rows.
  firm_id: integer("firm_id"),

  // SHA-256 lookup hash over normalized (tort_type|email|phone10) computed
  // at insert/update time so dedup can short-circuit the decrypt-loop scan
  // in lead-dedup.ts. Nullable for legacy rows backfilled lazily.
  lookup_hash: text("lookup_hash"),

  custom_fields: jsonb("custom_fields").$type<Record<string, unknown>>().notNull().default({}),

  // Decision Engine — convexity scoring (computed on create/update)
  convexity_score: varchar("convexity_score", { length: 20 }),
  convexity_action: varchar("convexity_action", { length: 20 }),
  convexity_rationale: text("convexity_rationale"),
  convexity_ruin_flags: jsonb("convexity_ruin_flags").$type<string[]>().notNull().default([]),
  convexity_downside_usd: decimal("convexity_downside_usd", { precision: 12, scale: 2 }),
  convexity_upside_usd: decimal("convexity_upside_usd", { precision: 12, scale: 2 }),
  convexity_ratio: decimal("convexity_ratio", { precision: 10, scale: 4 }),
  convexity_confidence: varchar("convexity_confidence", { length: 10 }),
  convexity_missing_fields: jsonb("convexity_missing_fields").$type<string[]>().notNull().default([]),
  convexity_contradictions: jsonb("convexity_contradictions").$type<string[]>().notNull().default([]),
  convexity_computed_at: timestamp("convexity_computed_at"),

  created_at: timestamp("created_at").defaultNow().notNull(),
  updated_at: timestamp("updated_at").defaultNow().notNull(),
}, (t) => ({
  statusIdx: index("leads_status_idx").on(t.status),
  tortTypeIdx: index("leads_tort_type_idx").on(t.tort_type),
  createdAtIdx: index("leads_created_at_idx").on(t.created_at),
  updatedAtIdx: index("leads_updated_at_idx").on(t.updated_at),
  vendorIdx: index("leads_vendor_id_idx").on(t.vendor_id),
  buyerIdx: index("leads_buyer_id_idx").on(t.buyer_id),
  assignedIdx: index("leads_assigned_to_idx").on(t.assigned_to),
  createdByIdx: index("leads_created_by_user_id_idx").on(t.created_by_user_id),
  statusCreatedIdx: index("leads_status_created_at_idx").on(t.status, t.created_at),
  tortStatusIdx: index("leads_tort_status_idx").on(t.tort_type, t.status),
  firmIdx: index("leads_firm_id_idx").on(t.firm_id),
  lookupHashIdx: index("leads_lookup_hash_idx").on(t.lookup_hash),
}));

export const insertLeadSchema = createInsertSchema(leadsTable).omit({
  id: true,
  created_at: true,
  updated_at: true,
});

export type InsertLead = z.infer<typeof insertLeadSchema>;
export type Lead = typeof leadsTable.$inferSelect;
