import { Router } from "express";
import { db, auditLogTable } from "@workspace/db";
import { desc, eq, sql, and, gte } from "drizzle-orm";

const router = Router();

router.get("/audit-trail", async (req, res) => {
  const limit = parseInt(req.query.limit as string) || 100;
  const entityType = req.query.entity_type as string | undefined;
  const action = req.query.action as string | undefined;

  let query = db
    .select()
    .from(auditLogTable)
    .orderBy(desc(auditLogTable.occurred_at))
    .limit(limit);

  const results = await query;

  let filtered = results;
  if (entityType) {
    filtered = filtered.filter(r => r.entity_type === entityType);
  }
  if (action) {
    filtered = filtered.filter(r => r.action === action);
  }

  res.json(filtered);
});

router.get("/audit-summary", async (_req, res) => {
  const byEntity = await db
    .select({
      entity_type: auditLogTable.entity_type,
      count: sql<number>`count(*)::int`,
    })
    .from(auditLogTable)
    .groupBy(auditLogTable.entity_type)
    .orderBy(sql`count(*) desc`);

  const byAction = await db
    .select({
      action: auditLogTable.action,
      count: sql<number>`count(*)::int`,
    })
    .from(auditLogTable)
    .groupBy(auditLogTable.action)
    .orderBy(sql`count(*) desc`);

  const now = new Date();
  const last24h = new Date(now.getTime() - 86400000);
  const last7d = new Date(now.getTime() - 7 * 86400000);

  const [recentCounts] = await db
    .select({
      total: sql<number>`count(*)::int`,
      last_24h: sql<number>`count(*) filter (where occurred_at >= ${last24h})::int`,
      last_7d: sql<number>`count(*) filter (where occurred_at >= ${last7d})::int`,
    })
    .from(auditLogTable);

  res.json({
    by_entity: byEntity,
    by_action: byAction,
    total_events: recentCounts.total,
    last_24h: recentCounts.last_24h,
    last_7d: recentCounts.last_7d,
  });
});

export default router;
