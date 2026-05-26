import {
  pgTable,
  serial,
  integer,
  varchar,
  text,
  timestamp,
  jsonb,
  index,
} from "drizzle-orm/pg-core";
import { leadsTable } from "./leads";
import { firmsTable } from "./firms";

// BAA-required PHI access log for the client portal.
// Every action that touches protected health information is written here:
// logins, document views, record views, provider connections, and all
// super-admin impersonation sessions. Rows are append-only — never updated
// or deleted — to preserve the audit trail required under HIPAA §164.312(b).
export const portalAuditLogTable = pgTable(
  "portal_audit_log",
  {
    id: serial("id").primaryKey(),

    // The authenticated portal user who performed the action.
    // NULL when an mtos admin impersonates (admin_user_id is set instead).
    portal_user_id: integer("portal_user_id"),

    // Set only for super-admin impersonation sessions. Records which internal
    // user accessed the client portal on the client's behalf.
    admin_user_id: integer("admin_user_id"),

    // The lead whose data was accessed — required for all PHI log entries.
    lead_id: integer("lead_id").references(() => leadsTable.id, { onDelete: "set null" }),

    // Firm scope for multi-tenant audit queries.
    firm_id: integer("firm_id")
      .notNull()
      .references(() => firmsTable.id, { onDelete: "cascade" }),

    // Coarse action taxonomy for HIPAA access-log reporting.
    // Format: "portal.<verb>_<noun>" — kept to a fixed vocabulary so reports
    // can group by action without free-text parsing.
    action: varchar("action", { length: 100 }).notNull(),
    // Examples:
    //   portal.login              portal.logout
    //   portal.view_case          portal.view_document
    //   portal.sign_document      portal.view_records
    //   portal.connect_provider   portal.revoke_provider
    //   portal.mfa_setup          portal.mfa_verify
    //   portal.password_set       portal.password_change
    //   portal.admin_impersonate  portal.signup_complete

    // Optional resource being acted upon (document, etc.).
    resource_type: varchar("resource_type", { length: 50 }),
    resource_id: integer("resource_id"),

    // Network context — required for HIPAA access-log completeness.
    ip_address: varchar("ip_address", { length: 45 }),
    user_agent: text("user_agent"),

    // Catch-all for provider names, error codes, outcome flags, etc.
    metadata: jsonb("metadata").$type<Record<string, unknown>>().default({}),

    // Immutable — no updated_at on an audit table.
    created_at: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => ({
    portalUserIdx: index("portal_audit_log_portal_user_idx").on(t.portal_user_id),
    adminUserIdx: index("portal_audit_log_admin_user_idx").on(t.admin_user_id),
    leadIdx: index("portal_audit_log_lead_idx").on(t.lead_id),
    firmIdx: index("portal_audit_log_firm_idx").on(t.firm_id),
    actionIdx: index("portal_audit_log_action_idx").on(t.action),
    createdAtIdx: index("portal_audit_log_created_at_idx").on(t.created_at),
    // Composite for "show all PHI access for lead X in date range" queries.
    leadCreatedIdx: index("portal_audit_log_lead_created_idx").on(t.lead_id, t.created_at),
  }),
);

export type PortalAuditLogEntry = typeof portalAuditLogTable.$inferSelect;
