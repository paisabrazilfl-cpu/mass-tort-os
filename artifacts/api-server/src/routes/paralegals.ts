import { Router } from "express";
import { db, paralegalsTable, leadsTable } from "@workspace/db";
import { eq, sql, desc } from "drizzle-orm";
import {
  CreateParalegalBody,
  GetParalegalParams,
  GetParalegalPerformanceParams,
} from "@workspace/api-zod";
import { decryptLeadArray } from "../lib/encryption";
import { requireRole, auditAction } from "../lib/rbac";

const router = Router();

router.get("/", requireRole("attorney"), async (_req, res) => {
  const paralegals = await db
    .select()
    .from(paralegalsTable)
    .orderBy(desc(paralegalsTable.signed_cases));
  res.json(paralegals);
});

router.post("/", requireRole("admin"), auditAction("create_paralegal"), async (req, res) => {
  // Zod validation up front: catches missing/wrong-type fields before they
  // hit the encrypted insert path. Mirrors the pattern used in leads.ts.
  const parsed = CreateParalegalBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ status: "error", code: "validation_failed", message: "Invalid request body", details: parsed.error.flatten() });
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

router.get("/:id", requireRole("attorney"), async (req, res) => {
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
  if (!p) { res.status(404).json({ error: "Not found" }); return; }

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

router.get("/:id/performance", requireRole("attorney"), async (req, res) => {
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
  if (!p) { res.status(404).json({ error: "Not found" }); return; }

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
