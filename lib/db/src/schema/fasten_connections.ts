import {
  pgTable,
  serial,
  integer,
  varchar,
  text,
  timestamp,
  jsonb,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { leadsTable } from "./leads";
import { firmsTable } from "./firms";

/**
 * Fasten Health connections — one row per (lead, healthcare provider portal)
 * the patient has authorized. Backend-agnostic: works with both the hosted
 * Fasten Connect API (org_connection_id is the SaaS handle) and the self-
 * hosted fasten-onprem deployment (org_connection_id is the internal source
 * id from the Fasten DB).
 *
 * Lifecycle:
 *   pending     → connect URL issued, patient hasn't completed OAuth yet
 *   active      → patient authorized, records are being / have been pulled
 *   syncing     → worker job currently downloading FHIR bundle
 *   synced      → records ingested into documents/case_facts
 *   reauth      → token expired, patient must reconnect
 *   revoked     → patient revoked access at provider, or operator disconnected
 *   error       → unrecoverable error (signature mismatch, provider 5xx, etc.)
 */
export const fastenConnectionsTable = pgTable(
  "fasten_connections",
  {
    id: serial("id").primaryKey(),
    firm_id: integer("firm_id")
      .notNull()
      .references(() => firmsTable.id, { onDelete: "cascade" }),
    lead_id: integer("lead_id")
      .notNull()
      .references(() => leadsTable.id, { onDelete: "cascade" }),

    // Backend that owns this connection. "connect" = hosted Fasten Connect API,
    // "onprem" = self-hosted fasten-onprem instance behind FASTEN_ONPREM_URL.
    backend: varchar("backend", { length: 16 }).notNull().default("connect"),

    // Stable handle Fasten uses for this (patient × provider) pair.
    // For Connect: the org_connection_id from /api/v1/bridge.
    // For on-prem: the source_id from /api/secure/source.
    org_connection_id: varchar("org_connection_id", { length: 128 }),

    // Catalog brand identifier (e.g. "epic", "cerner", "athena-prod-1").
    // Surfaced in the UI so an operator can see which portal the patient picked.
    portal_id: varchar("portal_id", { length: 128 }),
    portal_name: varchar("portal_name", { length: 255 }),

    // FHIR base URL the connection talks to. Helpful for ops debugging.
    fhir_endpoint: text("fhir_endpoint"),

    status: varchar("status", { length: 24 }).notNull().default("pending"),

    // Encrypted-at-rest sync token / refresh token if the backend hands one
    // back. We do NOT store raw OAuth tokens here for the hosted Connect
    // backend — Fasten owns those. The on-prem backend may return them.
    sync_token: text("sync_token"),

    // Last time we successfully pulled records from this connection.
    last_synced_at: timestamp("last_synced_at"),

    // Number of FHIR resources pulled in the most recent sync. Useful for
    // surfacing "we got X records" in the operator UI.
    last_resource_count: integer("last_resource_count").default(0),

    // Free-form provider response data (catalog metadata, scopes granted, etc).
    metadata: jsonb("metadata").default({}),

    // Most recent error string for ops debugging. Cleared on successful sync.
    last_error: text("last_error"),

    created_at: timestamp("created_at").defaultNow().notNull(),
    updated_at: timestamp("updated_at").defaultNow().notNull(),
  },
  (t) => ({
    leadIdx: index("fasten_connections_lead_idx").on(t.lead_id),
    firmIdx: index("fasten_connections_firm_idx").on(t.firm_id),
    statusIdx: index("fasten_connections_status_idx").on(t.status),
    // Each (firm, lead, portal) pair appears at most once — re-connecting
    // the same provider updates the existing row rather than duplicating.
    uniqLeadPortal: uniqueIndex("fasten_connections_lead_portal_uniq").on(
      t.lead_id,
      t.portal_id,
    ),
  }),
);

export const insertFastenConnectionSchema = createInsertSchema(fastenConnectionsTable).omit({
  id: true,
  created_at: true,
  updated_at: true,
});

export type InsertFastenConnection = z.infer<typeof insertFastenConnectionSchema>;
export type FastenConnection = typeof fastenConnectionsTable.$inferSelect;
