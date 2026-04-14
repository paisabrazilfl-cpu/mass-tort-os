import { Router } from "express";
import { db, paralegalsTable, leadsTable } from "@workspace/db";
import { eq, sql, desc } from "drizzle-orm";
import { decryptLeadArray } from "../lib/encryption";
import { requireRole, auditAction } from "../lib/rbac";

const router = Router();

router.get("/", async (_req, res) => {
  const paralegals = await db
    .select()
    .from(paralegalsTable)
    .orderBy(desc(paralegalsTable.signed_cases));
  res.json(paralegals);
});

router.post("/", requireRole("admin"), auditAction("create_paralegal"), async (req, res) => {
  const { name, email, role } = req.body;
  if (!name) {
    res.status(400).json({ error: "name is required" });
    return;
  }
  const [p] = await db.insert(paralegalsTable).values({ name, email, role }).returning();
  res.status(201).json(p);
});

router.get("/:id", async (req, res) => {
  const id = parseInt(req.params.id, 10);
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

router.get("/:id/performance", async (req, res) => {
  const id = parseInt(req.params.id, 10);
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
