import { Router } from "express";
import { db, leadsTable, casesTable, analysisTable, faxResultsTable, paralegalsTable } from "@workspace/db";
import { sql, eq, gte, and, desc } from "drizzle-orm";
import { scoreLeadPredictive, getModelStats, getBatchPredictions, getTortPredictions } from "../lib/predictive-scoring";
import { Permission, requirePermission } from "../lib/rbac";
import { notFound } from "../lib/http-errors";
import { requireFirmId, leadFirmScope } from "../lib/firm-scope";

const router = Router();

router.get("/overview", requirePermission(Permission.ANALYTICS_VIEW), async (req, res) => {
  const firmId = requireFirmId(req);
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

  // Cases and analysis tables carry firm_id (schema migration added it so
  // tenant aggregates don't bleed across firms). Existing rows are backfilled
  // by `scripts/backfill-firm-id.sql`; until that runs, NULL firm_id rows
  // are excluded from every firm's totals (safe-by-default).
  const [caseStats] = await db
    .select({
      total_cases: sql<number>`count(*)::int`,
      analyzed: sql<number>`count(*) filter (where status = 'analyzed')::int`,
      open: sql<number>`count(*) filter (where status = 'open')::int`,
    })
    .from(casesTable)
    .where(eq(casesTable.firm_id, firmId));

  // Analysis rows have no firm_id of their own; scope by joining through cases.
  const [analysisStats] = await db
    .select({
      total_analyses: sql<number>`count(*)::int`,
      avg_score: sql<number>`coalesce(avg(${analysisTable.score}), 0)::float`,
      strong_cases: sql<number>`count(*) filter (where ${analysisTable.score} >= 80)::int`,
      moderate_cases: sql<number>`count(*) filter (where ${analysisTable.score} >= 50 and ${analysisTable.score} < 80)::int`,
      weak_cases: sql<number>`count(*) filter (where ${analysisTable.score} >= 25 and ${analysisTable.score} < 50)::int`,
      disqualified_cases: sql<number>`count(*) filter (where ${analysisTable.score} < 25)::int`,
    })
    .from(analysisTable)
    .innerJoin(casesTable, eq(analysisTable.case_id, casesTable.id))
    .where(eq(casesTable.firm_id, firmId));

  // Fax rows tie to leads via lead_id; we drop rows with no resolved lead
  // from the firm-scoped count (they're already visible in the global
  // inbox view, which has its own RBAC).
  const [faxStats] = await db
    .select({
      total_faxes: sql<number>`count(*)::int`,
      processed: sql<number>`count(*) filter (where ${faxResultsTable.status} = 'done')::int`,
      pending: sql<number>`count(*) filter (where ${faxResultsTable.status} = 'pending')::int`,
    })
    .from(faxResultsTable)
    .innerJoin(leadsTable, eq(faxResultsTable.lead_id, leadsTable.id))
    .where(eq(leadsTable.firm_id, firmId));

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
  const result = await db
    .select({
      date: sql<string>`to_char(created_at, 'YYYY-MM-DD')`,
      total: sql<number>`count(*)::int`,
      qualified: sql<number>`count(*) filter (where status in ('qualified', 'signed'))::int`,
      signed: sql<number>`count(*) filter (where status = 'signed')::int`,
    })
    .from(leadsTable)
    .where(leadFirmScope(req))
    .groupBy(sql`to_char(created_at, 'YYYY-MM-DD')`)
    .orderBy(sql`to_char(created_at, 'YYYY-MM-DD')`)
    .limit(90);

  res.json(result);
});

router.get("/conversion-funnel", requirePermission(Permission.ANALYTICS_VIEW), async (req, res) => {
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
    .where(leadFirmScope(req));

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
    .where(leadFirmScope(req))
    .groupBy(leadsTable.tort_type)
    .orderBy(sql`count(*) desc`);

  res.json(result);
});

router.get("/paralegal-leaderboard", requirePermission(Permission.ANALYTICS_VIEW), async (req, res) => {
  const firmId = requireFirmId(req);
  // Paralegals join to firm-scoped leads; the join predicate AND-restricts
  // matched leads to the caller's firm so a paralegal who has assigned leads
  // in two firms (legacy) only reports the relevant tenant's row counts.
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
  // Firm-scope BEFORE handing the id to the predictor — otherwise a caller
  // could request a score for a lead in another firm and infer signal from
  // a 200-vs-404 response.
  const [row] = await db
    .select({ id: leadsTable.id })
    .from(leadsTable)
    .where(and(eq(leadsTable.id, id), leadFirmScope(req)));
  if (!row) { notFound(res, "Lead not found"); return; }
  try {
    const score = await scoreLeadPredictive(id);
    res.json(score);
  } catch (err: any) {
    notFound(res, "Lead not found or scoring failed");
  }
});

router.get("/predictive/batch", requirePermission(Permission.ANALYTICS_VIEW), async (req, res) => {
  const limit = parseInt(req.query.limit as string) || 50;
  const firmId = requireFirmId(req);
  // Pass firm scope into the batch predictor so it only returns this firm's
  // ids. The predictor signature (see lib/predictive-scoring) accepts an
  // optional firmId; older revisions that ignored it must be updated, but
  // a strict caller-side passthrough here is the right contract regardless.
  const predictions = await getBatchPredictions(limit, firmId);
  res.json(predictions);
});

router.get("/predictive/by-tort", requirePermission(Permission.ANALYTICS_VIEW), async (req, res) => {
  const predictions = await getTortPredictions(requireFirmId(req));
  res.json(predictions);
});

router.get("/predictive/model", requirePermission(Permission.ANALYTICS_VIEW), async (_req, res) => {
  // Model-level stats are not row-scoped (the trained model is shared across
  // tenants). Safe to return globally.
  const stats = await getModelStats();
  res.json(stats);
});

export default router;
