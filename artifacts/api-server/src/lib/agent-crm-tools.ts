// CRM read tools for the internal agent (Abby).
//
// Abby is the operator's private assistant. The base /api/ai-chat endpoint
// injects aggregate COUNTS (the CRM snapshot); these tools let Abby drill
// into ACTUAL ROWS — look up a specific lead, list documents on a lead,
// inspect the review queue, read job-queue status, browse tort form
// campaigns, etc. — so it can answer "tell me about lead 482" instead of
// refusing.
//
// TENANCY (Constitution house-rule #4): every lookup is firm-scoped where
// the table carries a firm_id. The owner super_admin (firmId === null) sees
// all firms. Tables that have NO firm column (cases, review_queue,
// job_queue — operational/global by design) are restricted to the
// super_admin so a regular firm operator can never read another tenant's
// operational rows through the agent. `form_configurations` are global tort
// campaign config (not firm-owned) and are readable by everyone.
//
// PII/ePHI minimization (house-rule #5): each entity exposes a CURATED
// column set. We deliberately omit free-text ePHI dumps (street address,
// DOB, physician contact, raw document file URLs, job payloads) — Abby gets
// enough to answer operational questions without shipping a full medical
// record to the LLM provider.

import {
  db,
  leadsTable,
  casesTable,
  documentsTable,
  reviewQueueTable,
  jobQueueTable,
  formConfigurationsTable,
} from "@workspace/db";
import { and, desc, eq, ilike, or, sql, type SQL } from "drizzle-orm";

export const CRM_ENTITIES = [
  "leads",
  "documents",
  "forms",
  "cases",
  "review",
  "jobs",
] as const;

export type CrmEntity = (typeof CRM_ENTITIES)[number];

export interface CrmLookupInput {
  entity: CrmEntity;
  /** Exact-id lookup (serial int for leads/documents/review/jobs, string for cases/forms). */
  id?: string | number;
  /** Free-text search across the entity's text columns. */
  search?: string;
  /** Status filter where the entity has a status column. */
  status?: string;
  /** Max rows (clamped 1..50, default 10). */
  limit?: number;
  /** Operator's firm scope; null = no firm filter (all firms). */
  firmId: number | null;
  /**
   * Whether the caller is the platform owner (super_admin). Controls access
   * to the non-firm-scoped operational tables (cases/review/jobs). Defaults
   * to `firmId === null` for backward compatibility, but callers should pass
   * it explicitly (derived from role) so super_admins with a concrete
   * firm_id are still recognized.
   */
  isSuperAdmin?: boolean;
  /** Caller's user id — required when `ownScope` is set. */
  userId?: number | null;
  /**
   * Restrict leads/documents to records ASSIGNED TO the caller. Set this for
   * roles that hold only the *_VIEW_OWN permission (no *_VIEW_ANY), so the
   * agent cannot read arbitrary firm records on their behalf.
   */
  ownScope?: boolean;
}

export interface CrmLookupResult {
  ok: boolean;
  entity: CrmEntity;
  /** Human-readable description of the scope/filter applied. */
  scope: string;
  count: number;
  rows: Record<string, unknown>[];
  /** Set when the lookup was refused or constrained for tenancy reasons. */
  note?: string;
}

function clampLimit(n: number | undefined): number {
  if (!n || !Number.isFinite(n)) return 10;
  return Math.max(1, Math.min(50, Math.floor(n)));
}

/** Tables with no firm_id column are super_admin-only via the agent. */
const SUPER_ADMIN_ONLY: ReadonlySet<CrmEntity> = new Set(["cases", "review", "jobs"]);

/**
 * Execute a firm-scoped CRM read. Never throws — DB errors are returned as
 * `ok:false` with a note so the agent can tell the operator gracefully.
 */
export async function runCrmLookup(input: CrmLookupInput): Promise<CrmLookupResult> {
  const { entity, firmId } = input;
  const limit = clampLimit(input.limit);
  const isSuperAdmin = input.isSuperAdmin ?? firmId === null;
  const ownScope = input.ownScope === true;
  const ownerId = input.userId ?? null;
  const search = input.search?.trim();
  const status = input.status?.trim();

  // Fail closed: an own-scoped read with no caller id could otherwise leak
  // the whole firm's records, so deny rather than silently widen scope.
  if (ownScope && ownerId === null) {
    return {
      ok: false,
      entity,
      scope: "restricted",
      count: 0,
      rows: [],
      note: "Cannot scope this lookup to your own records — no caller identity.",
    };
  }

  if (SUPER_ADMIN_ONLY.has(entity) && !isSuperAdmin) {
    return {
      ok: false,
      entity,
      scope: "restricted",
      count: 0,
      rows: [],
      note: `Row-level lookup of "${entity}" is limited to the platform owner (super_admin) because this table is not firm-scoped. Aggregate counts are available in the live CRM snapshot.`,
    };
  }

  try {
    switch (entity) {
      case "leads": {
        const conds: SQL[] = [];
        if (!isSuperAdmin && firmId !== null) conds.push(eq(leadsTable.firm_id, firmId));
        if (ownScope && ownerId !== null) conds.push(eq(leadsTable.assigned_to, ownerId));
        if (input.id != null) conds.push(eq(leadsTable.id, Number(input.id)));
        if (status) conds.push(eq(leadsTable.status, status));
        if (search) {
          const like = `%${search}%`;
          conds.push(
            or(
              ilike(leadsTable.name, like),
              ilike(leadsTable.email, like),
              ilike(leadsTable.phone, like),
              ilike(leadsTable.first_name, like),
              ilike(leadsTable.last_name, like),
            ) as SQL,
          );
        }
        const rows = await db
          .select({
            id: leadsTable.id,
            name: leadsTable.name,
            first_name: leadsTable.first_name,
            last_name: leadsTable.last_name,
            email: leadsTable.email,
            phone: leadsTable.phone,
            status: leadsTable.status,
            tort_type: leadsTable.tort_type,
            routing: leadsTable.routing,
            assigned_to: leadsTable.assigned_to,
            state: leadsTable.state,
            diagnosis_confirmed: leadsTable.diagnosis_confirmed,
            diagnosis_type: leadsTable.diagnosis_type,
            tcpa_consent: leadsTable.tcpa_consent,
            source: leadsTable.source,
            rejection_reason: leadsTable.rejection_reason,
          })
          .from(leadsTable)
          .where(conds.length ? and(...conds) : sql`true`)
          .orderBy(desc(leadsTable.id))
          .limit(limit);
        return {
          ok: true,
          entity,
          scope: isSuperAdmin ? "all firms" : `firm ${firmId}`,
          count: rows.length,
          rows,
        };
      }

      case "documents": {
        // documents has no firm_id; scope via the owning lead's firm.
        const conds: SQL[] = [];
        if (!isSuperAdmin && firmId !== null) conds.push(eq(leadsTable.firm_id, firmId));
        if (ownScope && ownerId !== null) conds.push(eq(leadsTable.assigned_to, ownerId));
        if (input.id != null) conds.push(eq(documentsTable.id, Number(input.id)));
        if (search) {
          // numeric search → lead_id; otherwise file name.
          const asNum = Number(search);
          if (Number.isInteger(asNum)) conds.push(eq(documentsTable.lead_id, asNum));
          else conds.push(ilike(documentsTable.file_name, `%${search}%`));
        }
        const rows = await db
          .select({
            id: documentsTable.id,
            lead_id: documentsTable.lead_id,
            document_type: documentsTable.document_type,
            file_name: documentsTable.file_name,
            signed: documentsTable.signed,
            signed_at: documentsTable.signed_at,
            created_at: documentsTable.created_at,
          })
          .from(documentsTable)
          .leftJoin(leadsTable, eq(documentsTable.lead_id, leadsTable.id))
          .where(conds.length ? and(...conds) : sql`true`)
          .orderBy(desc(documentsTable.created_at))
          .limit(limit);
        return {
          ok: true,
          entity,
          scope: isSuperAdmin ? "all firms" : `firm ${firmId} (via lead)`,
          count: rows.length,
          rows,
        };
      }

      case "forms": {
        const conds: SQL[] = [];
        if (input.id != null) conds.push(eq(formConfigurationsTable.id, String(input.id)));
        if (search) {
          const like = `%${search}%`;
          conds.push(
            or(
              ilike(formConfigurationsTable.id, like),
              ilike(formConfigurationsTable.label, like),
              ilike(formConfigurationsTable.category, like),
            ) as SQL,
          );
        }
        const rows = await db
          .select({
            id: formConfigurationsTable.id,
            label: formConfigurationsTable.label,
            category: formConfigurationsTable.category,
            active: formConfigurationsTable.active,
            mdl_status: formConfigurationsTable.mdl_status,
            sol_months: formConfigurationsTable.sol_months,
            avg_settlement_low: formConfigurationsTable.avg_settlement_low,
            avg_settlement_high: formConfigurationsTable.avg_settlement_high,
          })
          .from(formConfigurationsTable)
          .where(conds.length ? and(...conds) : sql`true`)
          .orderBy(formConfigurationsTable.label)
          .limit(limit);
        return { ok: true, entity, scope: "global (tort campaigns)", count: rows.length, rows };
      }

      case "cases": {
        const conds: SQL[] = [];
        if (input.id != null) conds.push(eq(casesTable.id, String(input.id)));
        if (status) conds.push(eq(casesTable.status, status));
        const rows = await db
          .select({
            id: casesTable.id,
            status: casesTable.status,
            assigned_to: casesTable.assigned_to,
            created_by_user_id: casesTable.created_by_user_id,
            created_at: casesTable.created_at,
            updated_at: casesTable.updated_at,
          })
          .from(casesTable)
          .where(conds.length ? and(...conds) : sql`true`)
          .orderBy(desc(casesTable.created_at))
          .limit(limit);
        return { ok: true, entity, scope: "all firms (super_admin)", count: rows.length, rows };
      }

      case "review": {
        const conds: SQL[] = [];
        if (input.id != null) conds.push(eq(reviewQueueTable.id, Number(input.id)));
        if (status) conds.push(eq(reviewQueueTable.resolution, status));
        if (search) {
          const like = `%${search}%`;
          conds.push(
            or(
              ilike(reviewQueueTable.summary, like),
              ilike(reviewQueueTable.conflict_type, like),
              ilike(reviewQueueTable.entity_id, like),
            ) as SQL,
          );
        }
        const rows = await db
          .select({
            id: reviewQueueTable.id,
            entity_type: reviewQueueTable.entity_type,
            entity_id: reviewQueueTable.entity_id,
            conflict_type: reviewQueueTable.conflict_type,
            severity: reviewQueueTable.severity,
            source_module: reviewQueueTable.source_module,
            summary: reviewQueueTable.summary,
            resolution: reviewQueueTable.resolution,
            created_at: reviewQueueTable.created_at,
          })
          .from(reviewQueueTable)
          .where(conds.length ? and(...conds) : sql`true`)
          .orderBy(desc(reviewQueueTable.created_at))
          .limit(limit);
        return { ok: true, entity, scope: "all firms (super_admin)", count: rows.length, rows };
      }

      case "jobs": {
        const conds: SQL[] = [];
        if (input.id != null) conds.push(eq(jobQueueTable.id, Number(input.id)));
        if (status) conds.push(eq(jobQueueTable.status, status));
        if (search) conds.push(ilike(jobQueueTable.job_type, `%${search}%`));
        const rows = await db
          .select({
            id: jobQueueTable.id,
            job_type: jobQueueTable.job_type,
            status: jobQueueTable.status,
            error: jobQueueTable.error,
            retry_count: jobQueueTable.retry_count,
            created_at: jobQueueTable.created_at,
            started_at: jobQueueTable.started_at,
            completed_at: jobQueueTable.completed_at,
          })
          .from(jobQueueTable)
          .where(conds.length ? and(...conds) : sql`true`)
          .orderBy(desc(jobQueueTable.created_at))
          .limit(limit);
        return { ok: true, entity, scope: "all firms (super_admin)", count: rows.length, rows };
      }

      default: {
        return {
          ok: false,
          entity,
          scope: "unknown",
          count: 0,
          rows: [],
          note: `Unknown entity "${entity}". Valid: ${CRM_ENTITIES.join(", ")}.`,
        };
      }
    }
  } catch (err) {
    return {
      ok: false,
      entity,
      scope: "error",
      count: 0,
      rows: [],
      note: `Lookup failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}
