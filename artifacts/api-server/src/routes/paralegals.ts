import { Router } from "express";
import { db, paralegalsTable, leadsTable } from "@workspace/db";
import { eq, sql, desc } from "drizzle-orm";
import { z } from "zod";
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


router.get("/", requirePermission(Permission.PARALEGAL_VIEW), async (_req, res) => {
  const paralegals = await db
    .select()
    .from(paralegalsTable)
    .orderBy(desc(paralegalsTable.signed_cases));
  res.json(paralegals);
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

  const leads = await db
    .select()
    .from(leadsTable)
    .where(eq(leadsTable.assigned_to, id))
    .orderBy(desc(leadsTable.updated_at));

  const signedCount = leads.filter(l => l.status === "signed").length;
  const qualifiedCount = leads.filter(l => l.status === "qualified").length;
  const totalAssigned = leads.length;
  const conversionRate = totalAssigned > 0 ? Math.round((signedCount / totalAssigned) * 100) : 0;

  res.json({
    ...p,
    leads: decryptLeadArray(leads),
    signed_cases: signedCount,
    active_cases: totalAssigned - signedCount,
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

  const leads = await db
    .select({
      status: leadsTable.status,
      count: sql<number>`count(*)::int`,
    })
    .from(leadsTable)
    .where(eq(leadsTable.assigned_to, id))
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
