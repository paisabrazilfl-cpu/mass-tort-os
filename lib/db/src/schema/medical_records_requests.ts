import {
  pgTable,
  serial,
  integer,
  text,
  timestamp,
  index,
} from "drizzle-orm/pg-core";
import { leadsTable } from "./leads";

/**
 * Tracks every outbound medical-records fax request sent to a provider on
 * behalf of a lead. One row per attempt — resends create a new row.
 *
 * Status lifecycle:
 *   pending  → job enqueued, fax not yet sent
 *   sent     → fax adapter accepted the request
 *   failed   → fax adapter rejected permanently (non-retryable)
 *   fulfilled → inbound records received and correlated to this request
 *   cancelled → manually cancelled by operator
 */
export const medicalRecordsRequestsTable = pgTable(
  "medical_records_requests",
  {
    id: serial("id").primaryKey(),

    lead_id: integer("lead_id")
      .notNull()
      .references(() => leadsTable.id, { onDelete: "cascade" }),

    // Denormalized from lead for fast firm-scoped queries without a join.
    firm_id: integer("firm_id"),

    // Provider that was faxed.
    hospital_name: text("hospital_name"),
    hospital_npi: text("hospital_npi"),
    fax_number: text("fax_number").notNull(),

    // HIPAA envelope that triggered this request (nullable for manual sends).
    envelope_id: integer("envelope_id"),

    // fax_results row for the OUTBOUND fax (the request we sent).
    fax_result_id: integer("fax_result_id"),

    status: text("status").notNull().default("pending"),

    sent_at: timestamp("sent_at", { withTimezone: true }),
    // Default SLA window: 14 days from send. Used for follow-up automation.
    expected_by: timestamp("expected_by", { withTimezone: true }),
    fulfilled_at: timestamp("fulfilled_at", { withTimezone: true }),

    // Counts resend attempts on this request (initial send = 1).
    attempt_count: integer("attempt_count").notNull().default(1),
    last_attempt_at: timestamp("last_attempt_at", { withTimezone: true }),

    // fax_results row for the INBOUND fax (the records that came back).
    response_fax_result_id: integer("response_fax_result_id"),

    notes: text("notes"),

    created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updated_at: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index("mrr_lead_id_idx").on(t.lead_id),
    index("mrr_firm_id_status_idx").on(t.firm_id, t.status),
    index("mrr_status_idx").on(t.status),
    index("mrr_expected_by_idx").on(t.expected_by),
    index("mrr_fax_number_idx").on(t.fax_number),
    index("mrr_created_at_idx").on(t.created_at),
  ],
);

export type MedicalRecordsRequest = typeof medicalRecordsRequestsTable.$inferSelect;
export type MedicalRecordsRequestInsert = typeof medicalRecordsRequestsTable.$inferInsert;
