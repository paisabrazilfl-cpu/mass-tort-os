import { Router } from "express";
import { db, leadsTable, documentsTable } from "@workspace/db";
import { eq, sql, and, gte } from "drizzle-orm";
import { Permission, requirePermission } from "../lib/rbac";

const router = Router();

router.get("/stats", requirePermission(Permission.DASHBOARD_VIEW), async (req, res) => {
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const startOfWeek = new Date(startOfToday);
  startOfWeek.setDate(startOfToday.getDate() - 7);

  const [counts] = await db
    .select({
      total: sql<number>`count(*)::int`,
      qualified: sql<number>`count(*) filter (where status = 'qualified')::int`,
      signed: sql<number>`count(*) filter (where status = 'signed')::int`,
      rejected: sql<number>`count(*) filter (where status = 'rejected')::int`,
      new_leads: sql<number>`count(*) filter (where status = 'new')::int`,
      total_ad_spend: sql<number>`coalesce(sum(ad_spend::numeric), 0)::float`,
      leads_today: sql<number>`count(*) filter (where created_at >= ${startOfToday})::int`,
      leads_this_week: sql<number>`count(*) filter (where created_at >= ${startOfWeek})::int`,
    })
    .from(leadsTable);

  const total = counts.total ?? 0;
  const qualified = counts.qualified ?? 0;
  const signed = counts.signed ?? 0;
  const rejected = counts.rejected ?? 0;
  const new_leads = counts.new_leads ?? 0;
  const total_ad_spend = counts.total_ad_spend ?? 0;

  const cpsr = signed > 0 && total_ad_spend > 0 ? total_ad_spend / signed : null;
  const qualification_rate = total > 0 ? (qualified + signed) / total : 0;
  const conversion_rate = total > 0 ? signed / total : 0;

  res.json({
    total_leads: total,
    qualified_leads: qualified,
    signed_retainers: signed,
    rejected_leads: rejected,
    new_leads,
    total_ad_spend,
    cpsr,
    qualification_rate,
    conversion_rate,
    leads_today: counts.leads_today ?? 0,
    leads_this_week: counts.leads_this_week ?? 0,
  });
});

router.get("/pipeline", requirePermission(Permission.DASHBOARD_VIEW), async (req, res) => {
  const byStatus = await db
    .select({
      status: leadsTable.status,
      count: sql<number>`count(*)::int`,
    })
    .from(leadsTable)
    .groupBy(leadsTable.status);

  const byTortType = await db
    .select({
      tort_type: leadsTable.tort_type,
      count: sql<number>`count(*)::int`,
      qualified: sql<number>`count(*) filter (where status = 'qualified')::int`,
      signed: sql<number>`count(*) filter (where status = 'signed')::int`,
    })
    .from(leadsTable)
    .groupBy(leadsTable.tort_type)
    .orderBy(sql`count(*) desc`);

  res.json({
    by_status: byStatus,
    by_tort_type: byTortType,
  });
});

router.get("/recent-activity", requirePermission(Permission.DASHBOARD_VIEW), async (req, res) => {
  const recentLeads = await db
    .select({
      id: leadsTable.id,
      lead_id: leadsTable.id,
      lead_name: leadsTable.name,
      status: leadsTable.status,
      tort_type: leadsTable.tort_type,
      created_at: leadsTable.created_at,
      updated_at: leadsTable.updated_at,
    })
    .from(leadsTable)
    .orderBy(sql`${leadsTable.updated_at} DESC`)
    .limit(20);

  const activity = recentLeads.map((lead, index) => {
    let event_type = "lead_updated";
    let description = `Lead updated`;

    const isNew =
      Math.abs(lead.created_at.getTime() - lead.updated_at.getTime()) < 5000;

    if (isNew) {
      event_type = "lead_created";
      description = `New lead submitted for ${lead.tort_type}`;
    } else if (lead.status === "qualified") {
      event_type = "lead_qualified";
      description = `Qualified for ${lead.tort_type} — ready for retainer`;
    } else if (lead.status === "signed") {
      event_type = "retainer_signed";
      description = `Retainer signed for ${lead.tort_type}`;
    } else if (lead.status === "rejected") {
      event_type = "lead_rejected";
      description = `Disqualified from ${lead.tort_type} pipeline`;
    }

    return {
      id: index + 1,
      lead_id: lead.lead_id,
      lead_name: lead.lead_name,
      event_type,
      description,
      occurred_at: lead.updated_at.toISOString(),
      tort_type: lead.tort_type,
    };
  });

  res.json(activity);
});

export default router;
