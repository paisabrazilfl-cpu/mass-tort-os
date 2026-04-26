import { Router } from "express";
import { db, auditLogTable } from "@workspace/db";
import { desc, eq, sql, and, gte } from "drizzle-orm";
import { requireRole } from "../lib/rbac";

const router = Router();

router.get("/audit-trail", requireRole("admin"), async (req, res) => {
  // Hard-cap to 1000 rows so an attacker (or a curious admin) can't request
  // limit=10000000 and OOM the container. Default 100.
  const rawLimit = parseInt(req.query.limit as string);
  const limit = Math.min(Math.max(Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : 100, 1), 1000);
  const entityType = req.query.entity_type == null ? undefined : String(req.query.entity_type);
  const action = req.query.action == null ? undefined : String(req.query.action);

  // BUG FIX: previously we ran `.limit(N)` against the whole table and then
  // applied entity_type/action filtering in JS. With a heavy audit log this
  // routinely returned 0 rows even when matches existed (the top-N most
  // recent entries simply didn't include the requested type/action).
  // Push filters into the SQL WHERE clause so the limit is applied AFTER
  // filtering, and so the new audit_log indexes can be used.
  const conditions = [];
  if (entityType) conditions.push(eq(auditLogTable.entity_type, entityType));
  if (action) conditions.push(eq(auditLogTable.action, action));

  const results =
    conditions.length > 0
      ? await db.select().from(auditLogTable).where(and(...conditions)).orderBy(desc(auditLogTable.occurred_at)).limit(limit)
      : await db.select().from(auditLogTable).orderBy(desc(auditLogTable.occurred_at)).limit(limit);

  res.json(results);
});

router.get("/audit-summary", requireRole("admin"), async (_req, res) => {
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
