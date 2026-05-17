import { pgTable, serial, text, timestamp, integer, jsonb, index } from "drizzle-orm/pg-core";
import { firmsTable } from "./firms";
import { usersTable } from "./users";

/**
 * Operator-initiated configuration snapshots.
 *
 * Stores firm-scoped JSON dumps of CONFIG/OPERATIONAL state that an
 * operator can restore after a misconfiguration or partial outage. The
 * snapshot payload deliberately EXCLUDES:
 *
 *   - leads / cases / documents — case-record tables, too large for
 *     app-level snapshots and already covered by Railway's Postgres
 *     plugin point-in-time backups.
 *   - audit_log — append-only by design; should never be restored.
 *   - Encrypted secrets in integrations.config.credentials — those stay
 *     in the vault. The snapshot stores integration METADATA only
 *     (name, type, provider, status, api_url, webhook_url,
 *     config.userConfig, api_key_hash) so restoring re-creates the row
 *     but the operator still has to re-paste any keys.
 *
 * What IS in a snapshot (V1):
 *   - workflow_settings (per-firm)
 *   - integrations (per-firm, metadata only — secrets redacted)
 *   - automation_workflows (per-firm, including graph)
 *   - document_templates (global at the schema layer; included because
 *     custom templates take real operator time to author)
 */
export const systemSnapshotsTable = pgTable("system_snapshots", {
  id: serial("id").primaryKey(),
  firm_id: integer("firm_id").notNull().references(() => firmsTable.id),
  created_by_user_id: integer("created_by_user_id").notNull().references(() => usersTable.id),
  name: text("name").notNull(),
  // Bytes 0..N of the JSON payload. Postgres TOAST handles large rows
  // transparently; in practice a firm's config snapshot is well under
  // 1 MB even with hundreds of automation workflows.
  payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
  // sha256 of the canonical JSON.stringify(payload). Lets a future
  // restore endpoint refuse to apply a payload that's been tampered
  // with at rest (defence-in-depth — the DB itself is the trust root).
  payload_sha256: text("payload_sha256").notNull(),
  byte_size: integer("byte_size").notNull(),
  // Per-table summary (counts) cached on the row so the list endpoint
  // doesn't need to fetch the full payload to show "12 workflows + 4
  // integrations + 7 templates".
  summary: jsonb("summary").$type<Record<string, number>>().notNull().default({}),
  notes: text("notes"),
  created_at: timestamp("created_at").defaultNow().notNull(),
}, (t) => ({
  firmCreatedIdx: index("system_snapshots_firm_created_idx").on(t.firm_id, t.created_at),
}));

export type SystemSnapshot = typeof systemSnapshotsTable.$inferSelect;
