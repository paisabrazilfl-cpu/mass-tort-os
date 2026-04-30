// Task #25: backfill leads.created_by_user_id so the viewer ownership
// filter doesn't 403 legacy NULL-owner rows. Mirror of
// case-ownership-backfill.ts; reuses `ensureSystemUser` (single fallback
// admin row at system@mtos.local) instead of creating a parallel one.
//
// Inference path is the same shape: walk the earliest audit_log entries
// whose entity_type='lead' and entity_id=String(lead.id), pick the first
// `created_by_user_id` that resolves to a real user row, else fall back
// to the system user. NOT NULL is NOT promoted here — leads is on a
// hotter write path than cases and the viewer-scope filter already
// tolerates NULL for the dev-synthetic id=0 path. The index, however, is
// idempotently asserted to keep the ownership filter on its hot index.
import { db, leadsTable, auditLogTable, usersTable } from "@workspace/db";
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { logger } from "./logger";
import { ensureSystemUser } from "./case-ownership-backfill";

export async function inferLeadOwnerFromAuditLog(lead_id: number): Promise<number | null> {
  const rows = await db
    .select({ details: auditLogTable.details })
    .from(auditLogTable)
    .where(
      and(
        eq(auditLogTable.entity_type, "lead"),
        eq(auditLogTable.entity_id, String(lead_id)),
      ),
    )
    .orderBy(asc(auditLogTable.occurred_at))
    .limit(100);

  for (const row of rows) {
    const details = row.details;
    if (!details || typeof details !== "object" || Array.isArray(details)) continue;
    const candidate = (details as Record<string, unknown>)["created_by_user_id"];
    if (typeof candidate !== "number" || !Number.isInteger(candidate) || candidate <= 0) continue;
    const userExists = await db
      .select({ id: usersTable.id })
      .from(usersTable)
      .where(eq(usersTable.id, candidate))
      .limit(1);
    if (userExists[0]) return userExists[0].id;
  }
  return null;
}

export interface LeadBackfillResult {
  scanned: number;
  inferredFromAudit: number;
  fallbackToSystem: number;
  systemUserId: number;
}

// True only when both `leads` and `mtos_users` exist in the current
// schema. Lets the post-merge runner skip cleanly on a fresh DB where
// the schema is about to be created from scratch.
export async function leadOwnershipTablesExist(): Promise<boolean> {
  const result = await db.execute(sql`
    SELECT
      EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_schema = current_schema() AND table_name = 'leads'
      ) AS leads_exists,
      EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_schema = current_schema() AND table_name = 'mtos_users'
      ) AS users_exists
  `);
  const row = (result as unknown as { rows: Array<{ leads_exists: boolean; users_exists: boolean }> }).rows[0];
  return Boolean(row?.leads_exists && row?.users_exists);
}

export async function backfillLeadOwnership(): Promise<LeadBackfillResult> {
  const systemUserId = await ensureSystemUser();
  const orphans = await db
    .select({ id: leadsTable.id })
    .from(leadsTable)
    .where(isNull(leadsTable.created_by_user_id));

  let inferredFromAudit = 0;
  let fallbackToSystem = 0;
  for (const { id } of orphans) {
    const inferred = await inferLeadOwnerFromAuditLog(id);
    const owner = inferred ?? systemUserId;
    if (inferred !== null) inferredFromAudit++;
    else fallbackToSystem++;
    await db
      .update(leadsTable)
      .set({ created_by_user_id: owner, updated_at: new Date() })
      .where(and(eq(leadsTable.id, id), isNull(leadsTable.created_by_user_id)));
  }

  if (orphans.length > 0) {
    logger.info(
      { scanned: orphans.length, inferredFromAudit, fallbackToSystem },
      "Lead ownership backfill applied",
    );
  }

  return {
    scanned: orphans.length,
    inferredFromAudit,
    fallbackToSystem,
    systemUserId,
  };
}

// Idempotent ownership index. Unlike cases, `leads.created_by_user_id`
// stays nullable so legacy ingest paths (vendor webhooks lacking a user
// context) do not break — the viewer-scope filter already handles NULL.
export async function applyLeadOwnershipDdl(): Promise<void> {
  await db.execute(sql`CREATE INDEX IF NOT EXISTS leads_created_by_user_id_idx ON leads (created_by_user_id)`);
}
