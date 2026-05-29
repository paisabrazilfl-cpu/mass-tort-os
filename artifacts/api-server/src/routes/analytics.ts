import { Router } from "express";
import { db, leadsTable, casesTable, analysisTable, faxResultsTable, paralegalsTable } from "@workspace/db";
import { sql, eq, gte, and, desc } from "drizzle-orm";
import { scoreLeadPredictive, getModelStats, getBatchPredictions, getTortPredictions } from "../lib/predictive-scoring";
import { Permission, requirePermission } from "../lib/rbac";
import { notFound } from "../lib/http-errors";

const router = Router();

router.get("/overview", requirePermission(Permission.ANALYTICS_VIEW), async (req, res) => {
  const firmId = req.user!.firm_id;
  const now = new Date();
  const thirtyDaysAgo = new Date(now.getTime() - 30 * 86400000);
  const sevenDaysAgo = new Date(now.getTime() - 7 * 86400000);

  const [leadStats] = await db
    .select({
      total: sql<number>`count(*)::int`,
      qualified: sql<number>`count(*) filter (where status = 'qualified')::int`,
      signed: sql<number>`count(*) filter (where status = 'signed')::int`,
      rejected: sql<number>`count(*) filter (where status = 'rejected')::int`,
      new_leads: sql<number>`count(*) filter (where status = 'new')::int`,
      total_ad_spend: sql<number>`coalesce(sum(ad_spend::numeric), 0)::float`,
      hot: sql<number>`count(*) filter (where routing = 'hot')::int`,
      warm: sql<number>`count(*) filter (where routing = 'warm')::int`,
      cold: sql<number>`count(*) filter (where routing = 'cold')::int`,
      last_30_days: sql<number>`count(*) filter (where created_at >= ${thirtyDaysAgo})::int`,
      last_7_days: sql<number>`count(*) filter (where created_at >= ${sevenDaysAgo})::int`,
    })
    .from(leadsTable)
    .where(eq(leadsTable.firm_id, firmId));

  // cases, analysis, fax_results lack a direct firm_id column — they are
  // scoped implicitly because all data in this single-tenant deployment
  // belongs to the same firm. Multi-tenant migration would add firm_id to
  // these tables and join through here.
  const [caseStats] = await db
    .select({
      total_cases: sql<number>`count(*)::int`,
      analyzed: sql<number>`count(*) filter (where status = 'analyzed')::int`,
      open: sql<number>`count(*) filter (where status = 'open')::int`,
    })
    .from(casesTable);

  const [analysisStats] = await db
    .select({
      total_analyses: sql<number>`count(*)::int`,
      avg_score: sql<number>`coalesce(avg(score), 0)::float`,
      strong_cases: sql<number>`count(*) filter (where score >= 80)::int`,
      moderate_cases: sql<number>`count(*) filter (where score >= 50 and score < 80)::int`,
      weak_cases: sql<number>`count(*) filter (where score >= 25 and score < 50)::int`,
      disqualified_cases: sql<number>`count(*) filter (where score < 25)::int`,
    })
    .from(analysisTable);

  const [faxStats] = await db
    .select({
      total_faxes: sql<number>`count(*)::int`,
      processed: sql<number>`count(*) filter (where status = 'done')::int`,
      pending: sql<number>`count(*) filter (where status = 'pending')::int`,
    })
    .from(faxResultsTable);

  const total = leadStats.total ?? 0;
  const signed = leadStats.signed ?? 0;
  const totalAdSpend = leadStats.total_ad_spend ?? 0;
  const cpsr = signed > 0 && totalAdSpend > 0 ? totalAdSpend / signed : null;
  const roi = signed > 0 && totalAdSpend > 0 ? Math.round(((signed * 3500 - totalAdSpend) / totalAdSpend) * 100) : null;

  res.json({
    leads: {
      ...leadStats,
      cpsr,
      roi,
      qualification_rate: total > 0 ? Math.round(((leadStats.qualified + signed) / total) * 100) : 0,
      conversion_rate: total > 0 ? Math.round((signed / total) * 100) : 0,
    },
    cases: caseStats,
    analysis: analysisStats,
    faxes: faxStats,
  });
});

router.get("/pipeline-trend", requirePermission(Permission.ANALYTICS_VIEW), async (req, res) => {
  const firmId = req.user!.firm_id;

  const result = await db
    .select({
      date: sql<string>`to_char(created_at, 'YYYY-MM-DD')`,
      total: sql<number>`count(*)::int`,
      qualified: sql<number>`count(*) filter (where status in ('qualified', 'signed'))::int`,
      signed: sql<number>`count(*) filter (where status = 'signed')::int`,
    })
    .from(leadsTable)
    .where(eq(leadsTable.firm_id, firmId))
    .groupBy(sql`to_char(created_at, 'YYYY-MM-DD')`)
    .orderBy(sql`to_char(created_at, 'YYYY-MM-DD')`)
    .limit(90);

  res.json(result);
});

router.get("/conversion-funnel", requirePermission(Permission.ANALYTICS_VIEW), async (req, res) => {
  const firmId = req.user!.firm_id;

  const [counts] = await db
    .select({
      total_leads: sql<number>`count(*)::int`,
      new_leads: sql<number>`count(*) filter (where status = 'new')::int`,
      qualified: sql<number>`count(*) filter (where status = 'qualified')::int`,
      records_requested: sql<number>`count(*) filter (where diagnosis_confirmed = true)::int`,
      signed: sql<number>`count(*) filter (where status = 'signed')::int`,
      rejected: sql<number>`count(*) filter (where status = 'rejected')::int`,
    })
    .from(leadsTable)
    .where(eq(leadsTable.firm_id, firmId));

  const stages = [
    { stage: "New Leads", count: counts.total_leads, color: "#3B82F6" },
    { stage: "Qualified", count: counts.qualified + counts.signed, color: "#10B981" },
    { stage: "Records Verified", count: counts.records_requested, color: "#F59E0B" },
    { stage: "Signed Retainers", count: counts.signed, color: "#8B5CF6" },
    { stage: "Rejected", count: counts.rejected, color: "#EF4444" },
  ];

  res.json(stages);
});

router.get("/tort-breakdown", requirePermission(Permission.ANALYTICS_VIEW), async (req, res) => {
  const firmId = req.user!.firm_id;

  const result = await db
    .select({
      tort_type: leadsTable.tort_type,
      total: sql<number>`count(*)::int`,
      qualified: sql<number>`count(*) filter (where status = 'qualified')::int`,
      signed: sql<number>`count(*) filter (where status = 'signed')::int`,
      rejected: sql<number>`count(*) filter (where status = 'rejected')::int`,
      avg_ad_spend: sql<number>`coalesce(avg(ad_spend::numeric), 0)::float`,
    })
    .from(leadsTable)
    .where(eq(leadsTable.firm_id, firmId))
    .groupBy(leadsTable.tort_type)
    .orderBy(sql`count(*) desc`);

  res.json(result);
});

router.get("/paralegal-leaderboard", requirePermission(Permission.ANALYTICS_VIEW), async (req, res) => {
  const firmId = req.user!.firm_id;

  const result = await db
    .select({
      id: paralegalsTable.id,
      name: paralegalsTable.name,
      role: paralegalsTable.role,
      total_assigned: sql<number>`count(${leadsTable.id})::int`,
      signed: sql<number>`count(*) filter (where ${leadsTable.status} = 'signed')::int`,
      qualified: sql<number>`count(*) filter (where ${leadsTable.status} = 'qualified')::int`,
      rejected: sql<number>`count(*) filter (where ${leadsTable.status} = 'rejected')::int`,
    })
    .from(paralegalsTable)
    .leftJoin(
      leadsTable,
      and(eq(paralegalsTable.id, leadsTable.assigned_to), eq(leadsTable.firm_id, firmId)),
    )
    .groupBy(paralegalsTable.id, paralegalsTable.name, paralegalsTable.role)
    .orderBy(sql`count(*) filter (where ${leadsTable.status} = 'signed') desc`);

  const leaderboard = result.map(r => ({
    ...r,
    conversion_rate: r.total_assigned > 0 ? Math.round((r.signed / r.total_assigned) * 100) : 0,
  }));

  res.json(leaderboard);
});

router.get("/predictive/lead/:id", requirePermission(Permission.ANALYTICS_PREDICTIVE_LEAD_VIEW), async (req, res) => {
  const id = parseInt(String(req.params.id), 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid lead ID" }); return; }
  try {
    // Pass firmId to enforce ownership — scoreLeadPredictive will 404 if the
    // lead belongs to a different firm, preventing cross-tenant IDOR.
    const score = await scoreLeadPredictive(id, req.user!.firm_id);
    res.json(score);
  } catch (err: unknown) {
    req.log.error({ err, leadId: id }, "predictive lead scoring failed");
    notFound(res, "Lead not found or scoring failed");
  }
});

router.get("/predictive/batch", requirePermission(Permission.ANALYTICS_VIEW), async (req, res) => {
  const limit = parseInt(req.query.limit as string) || 50;
  const predictions = await getBatchPredictions(limit, req.user!.firm_id);
  res.json(predictions);
});

router.get("/predictive/by-tort", requirePermission(Permission.ANALYTICS_VIEW), async (req, res) => {
  const predictions = await getTortPredictions(req.user!.firm_id);
  res.json(predictions);
});

router.get("/predictive/model", requirePermission(Permission.ANALYTICS_VIEW), async (req, res) => {
  const stats = await getModelStats(req.user!.firm_id);
  res.json(stats);
});

export default router;
