import { Router } from "express";
import { db, paralegalsTable, leadsTable } from "@workspace/db";
import { eq, sql, desc, and } from "drizzle-orm";
import { z } from "zod";
import { requireFirmId } from "../lib/firm-scope";
import {
  GetParalegalParams,
  GetParalegalPerformanceParams,
} from "@workspace/api-zod";

// Stricter than the generated CreateParalegalBody (which only enforces
// `string | null`): this validates email format and constrains role to a
// small operator-facing enum. The DB column is varchar(100) NOT NULL with a
// default of "Paralegal", so the enum stays a closed list — admins can ask
// for new roles to be added explicitly. Anything outside this set 400s with
// `details` listing the bad field, instead of silently writing garbage.
const PARALEGAL_ROLES = [
  "Paralegal",
  "Senior Paralegal",
  "Lead Paralegal",
  "Intake Specialist",
  "Case Manager",
] as const;
const CreateParalegalSchema = z.object({
  name: z.string().min(1, "name is required").max(255),
  email: z.string().email("must be a valid email").max(255).nullish(),
  role: z.enum(PARALEGAL_ROLES).optional(),
});
import { decryptLeadArray } from "../lib/encryption";
import { Permission, requirePermission, auditAction } from "../lib/rbac";

const router = Router();


router.get("/", requirePermission(Permission.PARALEGAL_VIEW), async (req, res) => {
  // Tort + state filters power the n8n lead-assignment workflow (Task #52).
  // A paralegal whose `assigned_torts` / `licensed_states` is NULL acts
  // as a wildcard — that way operators don't have to backfill every row
  // before round-robin keeps working. Sort=load_asc returns the lowest
  // active-case count first so the workflow can pick `[0]`.
  const tortFilter = typeof req.query.tort === "string" ? req.query.tort : undefined;
  const stateFilter = typeof req.query.state === "string" ? req.query.state.toUpperCase() : undefined;
  const sortLoadAsc = req.query.sort === "load_asc";
  // Compute counts live from the leads table. The integer columns
  // total_assigned / signed_cases / active_cases on the paralegals row are
  // legacy denormalized counters that were never wired to update on lead
  // status changes, so reading them directly always returned 0 even when
  // leads were assigned. The leaderboard endpoint
  // (/api/analytics/paralegal-leaderboard) already does this same join, so
  // both surfaces now agree.
  // NULL on the array column means "any" (wildcard); a non-null array
  // must contain the requested value. Using = ANY(array) so postgres
  // can use a GIN index later if/when we add one.
  const tortPredicate = tortFilter
    ? sql`(${paralegalsTable.assigned_torts} IS NULL OR ${tortFilter} = ANY(${paralegalsTable.assigned_torts}))`
    : sql`TRUE`;
  const statePredicate = stateFilter
    ? sql`(${paralegalsTable.licensed_states} IS NULL OR ${stateFilter} = ANY(${paralegalsTable.licensed_states}))`
    : sql`TRUE`;

  const orderBy = sortLoadAsc
    ? sql`count(*) filter (where ${leadsTable.status} not in ('signed','rejected') and ${leadsTable.id} is not null) asc, ${paralegalsTable.id} asc`
    : sql`count(*) filter (where ${leadsTable.status} = 'signed') desc`;

  // Counts must aggregate ONLY this firm's leads. paralegals rows themselves
  // are global (no firm_id column — the table is a shared directory) but the
  // lead counts hanging off them are tenant data. The previous LEFT JOIN with
  // no firm filter summed every firm's leads into a single number, which leaks
  // workload across firms and produces misleading "load_asc" assignments.
  const firmId = requireFirmId(req);
  const leadFirmPredicate = eq(leadsTable.firm_id, firmId);

  const rows = await db
    .select({
      id: paralegalsTable.id,
      name: paralegalsTable.name,
      email: paralegalsTable.email,
      role: paralegalsTable.role,
      assigned_torts: paralegalsTable.assigned_torts,
      licensed_states: paralegalsTable.licensed_states,
      created_at: paralegalsTable.created_at,
      updated_at: paralegalsTable.updated_at,
      total_assigned: sql<number>`count(${leadsTable.id})::int`,
      signed_cases: sql<number>`count(*) filter (where ${leadsTable.status} = 'signed')::int`,
      active_cases: sql<number>`count(*) filter (where ${leadsTable.status} not in ('signed','rejected') and ${leadsTable.id} is not null)::int`,
    })
    .from(paralegalsTable)
    // LEFT JOIN with the firm filter in the ON clause so paralegals with zero
    // leads in this firm still appear (with counts = 0) instead of vanishing.
    .leftJoin(leadsTable, and(eq(paralegalsTable.id, leadsTable.assigned_to), leadFirmPredicate))
    .where(and(tortPredicate, statePredicate))
    .groupBy(
      paralegalsTable.id,
      paralegalsTable.name,
      paralegalsTable.email,
      paralegalsTable.role,
      paralegalsTable.assigned_torts,
      paralegalsTable.licensed_states,
      paralegalsTable.created_at,
      paralegalsTable.updated_at,
    )
    .orderBy(orderBy);
  res.json(rows);
});

router.post("/", requirePermission(Permission.PARALEGAL_MANAGE), auditAction("create_paralegal"), async (req, res) => {
  // CreateParalegalSchema (above) is stricter than the OpenAPI-generated
  // CreateParalegalBody: it enforces that `email` is a valid RFC-compliant
  // address (or null/omitted) and that `role` is one of a small operator
  // facing enum, not arbitrary free text. Without this guard the DB would
  // happily store `"role": "<script>"` or `"email": "not-an-email"`.
  const parsed = CreateParalegalSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      status: "error",
      code: "validation_failed",
      message: "Invalid request body",
      details: parsed.error.flatten(),
    });
    return;
  }
  const { name, email, role } = parsed.data;
  // role has NOT NULL + default("Paralegal") in the schema, so passing
  // undefined lets the DB default apply. email is nullable, so an explicit
  // null is fine when the client omits it.
  const [p] = await db
    .insert(paralegalsTable)
    .values({
      name,
      email: email ?? null,
      role: role ?? undefined,
    })
    .returning();
  res.status(201).json(p);
});

router.get("/:id", requirePermission(Permission.PARALEGAL_VIEW), auditAction("view_paralegal"), async (req, res) => {
  // GetParalegalParams uses zod.coerce.number() which safely converts the
  // string param to int and rejects garbage like "abc" with a parse error
  // instead of producing NaN.
  const parsed = GetParalegalParams.safeParse({ id: req.params.id });
  if (!parsed.success) {
    res.status(400).json({ status: "error", code: "invalid_id", message: "Paralegal id must be a positive integer" });
    return;
  }
  const id = parsed.data.id;
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ status: "error", code: "invalid_id", message: "Paralegal id must be a positive integer" });
    return;
  }
  const [p] = await db.select().from(paralegalsTable).where(eq(paralegalsTable.id, id));
  if (!p) { res.status(404).json({ status: "error", code: "not_found", message: "Paralegal not found" }); return; }

  // Scope the assigned-leads view to the caller's firm. paralegals are
  // global but each lead is tenant data; the previous query returned every
  // firm's leads assigned to this paralegal, which is a cross-tenant leak.
  const firmId = requireFirmId(req);
  const leads = await db
    .select()
    .from(leadsTable)
    .where(and(eq(leadsTable.assigned_to, id), eq(leadsTable.firm_id, firmId)))
    .orderBy(desc(leadsTable.updated_at));

  const signedCount = leads.filter(l => l.status === "signed").length;
  const qualifiedCount = leads.filter(l => l.status === "qualified").length;
  const rejectedCount = leads.filter(l => l.status === "rejected").length;
  const totalAssigned = leads.length;
  const conversionRate = totalAssigned > 0 ? Math.round((signedCount / totalAssigned) * 100) : 0;

  res.json({
    ...p,
    leads: decryptLeadArray(leads),
    signed_cases: signedCount,
    // Match the list/leaderboard rule: active = neither signed nor rejected.
    // Previously this was `totalAssigned - signedCount`, which incorrectly
    // counted rejected leads as still active and disagreed with the list
    // endpoint and leaderboard.
    active_cases: totalAssigned - signedCount - rejectedCount,
    total_assigned: totalAssigned,
    conversion_rate: conversionRate,
  });
});

router.delete("/:id", requirePermission(Permission.PARALEGAL_MANAGE), auditAction("delete_paralegal"), async (req, res) => {
  const parsed = GetParalegalParams.safeParse({ id: req.params.id });
  if (!parsed.success || !Number.isInteger(parsed.data.id) || parsed.data.id <= 0) {
    res.status(400).json({ status: "error", code: "invalid_id", message: "Paralegal id must be a positive integer" });
    return;
  }
  const id = parsed.data.id;
  const [p] = await db.select().from(paralegalsTable).where(eq(paralegalsTable.id, id));
  if (!p) {
    res.status(404).json({ status: "error", code: "not_found", message: "Paralegal not found" });
    return;
  }
  // Null out leads.assigned_to so we never leave orphaned references,
  // then delete the paralegal. Drizzle returns the updated rows so we can
  // report the count to the caller without a separate SELECT.
  const unassignedLeads = await db
    .update(leadsTable)
    .set({ assigned_to: null })
    .where(eq(leadsTable.assigned_to, id))
    .returning({ id: leadsTable.id });
  const leadsUnassigned = unassignedLeads.length;
  await db.delete(paralegalsTable).where(eq(paralegalsTable.id, id));
  res.json({ message: `Paralegal "${p.name}" deleted`, leads_unassigned: leadsUnassigned });
});

router.get("/:id/performance", requirePermission(Permission.PARALEGAL_VIEW), auditAction("view_paralegal_performance"), async (req, res) => {
  const parsed = GetParalegalPerformanceParams.safeParse({ id: req.params.id });
  if (!parsed.success) {
    res.status(400).json({ status: "error", code: "invalid_id", message: "Paralegal id must be a positive integer" });
    return;
  }
  const id = parsed.data.id;
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ status: "error", code: "invalid_id", message: "Paralegal id must be a positive integer" });
    return;
  }
  const [p] = await db.select().from(paralegalsTable).where(eq(paralegalsTable.id, id));
  if (!p) { res.status(404).json({ status: "error", code: "not_found", message: "Paralegal not found" }); return; }

  // Scope the per-status counts to the caller's firm — same reason as the
  // /:id detail route above.
  const firmId = requireFirmId(req);
  const leads = await db
    .select({
      status: leadsTable.status,
      count: sql<number>`count(*)::int`,
    })
    .from(leadsTable)
    .where(and(eq(leadsTable.assigned_to, id), eq(leadsTable.firm_id, firmId)))
    .groupBy(leadsTable.status);

  const totalAssigned = leads.reduce((sum, l) => sum + l.count, 0);
  const signed = leads.find(l => l.status === "signed")?.count ?? 0;
  const qualified = leads.find(l => l.status === "qualified")?.count ?? 0;

  res.json({
    paralegal: p,
    breakdown: leads,
    total_assigned: totalAssigned,
    signed,
    qualified,
    conversion_rate: totalAssigned > 0 ? Math.round((signed / totalAssigned) * 100) : 0,
  });
});

export default router;
