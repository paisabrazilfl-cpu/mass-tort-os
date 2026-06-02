import { pgTable, serial, varchar, text, timestamp, integer, jsonb, index } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { leadsTable } from "./leads";
import { documentTemplatesTable } from "./document_templates";
import { documentsTable } from "./documents";

/**
 * One row per envelope sent through an e-sign provider.
 * Lifecycle: created → sent → delivered → viewed → signed (or declined / expired / voided / error).
 */
export const documentEnvelopesTable = pgTable("document_envelopes", {
  id: serial("id").primaryKey(),
  lead_id: integer("lead_id")
    .notNull()
    .references(() => leadsTable.id, { onDelete: "cascade" }),
  template_id: integer("template_id").references(() => documentTemplatesTable.id, {
    onDelete: "set null",
  }),
  document_id: integer("document_id").references(() => documentsTable.id, {
    onDelete: "set null",
  }),
  provider: varchar("provider", { length: 50 }).notNull(),
  provider_integration_id: integer("provider_integration_id"),
  external_envelope_id: varchar("external_envelope_id", { length: 255 }),
  // Intake-to-Med-Recs pipeline (Task #168): which of the three required
  // pipeline documents this envelope represents — "hipaa" | "retainer" |
  // "affidavit" — or null for any non-pipeline envelope. The DOCS_SIGNED gate
  // tracks each required type independently, so this is how a lead's signing
  // packet is recognised as fully executed.
  doc_type: varchar("doc_type", { length: 40 }),
  signer_name: varchar("signer_name", { length: 255 }),
  signer_email: varchar("signer_email", { length: 255 }),
  status: varchar("status", { length: 30 }).notNull().default("created"),
  status_detail: text("status_detail"),
  sent_at: timestamp("sent_at"),
  delivered_at: timestamp("delivered_at"),
  viewed_at: timestamp("viewed_at"),
  signed_at: timestamp("signed_at"),
  declined_at: timestamp("declined_at"),
  signed_pdf_path: text("signed_pdf_path"),
  events: jsonb("events").$type<EnvelopeEvent[]>().notNull().default([]),
  metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
  last_error: text("last_error"),
  created_at: timestamp("created_at").defaultNow().notNull(),
  updated_at: timestamp("updated_at").defaultNow().notNull(),
}, (t) => ({
  leadIdx: index("document_envelopes_lead_id_idx").on(t.lead_id),
  leadStatusIdx: index("document_envelopes_lead_status_idx").on(t.lead_id, t.status),
  externalIdx: index("document_envelopes_external_id_idx").on(t.external_envelope_id),
}));

export interface EnvelopeEvent {
  type: string;
  at: string;
  raw?: Record<string, unknown>;
}

export const insertDocumentEnvelopeSchema = createInsertSchema(documentEnvelopesTable).omit({
  id: true,
  created_at: true,
  updated_at: true,
});

export type DocumentEnvelope = typeof documentEnvelopesTable.$inferSelect;
export type InsertDocumentEnvelope = z.infer<typeof insertDocumentEnvelopeSchema>;
