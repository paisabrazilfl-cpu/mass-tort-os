import { Router } from "express";
import { db, securityAlertsTable, blockedIpsTable } from "@workspace/db";
import { eq, desc, sql, gte, and, count } from "drizzle-orm";
import { analyzeThreats } from "../lib/threat-analyzer";
import { logger } from "../lib/logger";
import { requireRole } from "../lib/rbac";
import { auditLog } from "../lib/audit";
import { getUnacknowledgedNotifications, acknowledgeNotification, dispatchCriticalAlert } from "../lib/security-alerts";

const router = Router();

router.use(requireRole("admin"));

router.get("/alerts", async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit as string) || 50, 200);
  const severity = String(req.query.severity ?? "");
  const status = String(req.query.status ?? "");

  const conditions = [];
  if (severity) conditions.push(eq(securityAlertsTable.severity, severity));
  if (status) conditions.push(eq(securityAlertsTable.status, status));

  const alerts = conditions.length > 0
    ? await db.select().from(securityAlertsTable).where(and(...conditions)).orderBy(desc(securityAlertsTable.created_at)).limit(limit)
    : await db.select().from(securityAlertsTable).orderBy(desc(securityAlertsTable.created_at)).limit(limit);

  res.json(alerts);
});

router.get("/stats", async (_req, res) => {
  const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);

  const [totalAlerts24h] = await db
    .select({ count: count() })
    .from(securityAlertsTable)
    .where(gte(securityAlertsTable.created_at, twentyFourHoursAgo));

  const [criticalAlerts24h] = await db
    .select({ count: count() })
    .from(securityAlertsTable)
    .where(and(
      gte(securityAlertsTable.created_at, twentyFourHoursAgo),
      eq(securityAlertsTable.severity, "critical")
    ));

  const [alertsLastHour] = await db
    .select({ count: count() })
    .from(securityAlertsTable)
    .where(gte(securityAlertsTable.created_at, oneHourAgo));

  const [blockedCount] = await db
    .select({ count: count() })
    .from(blockedIpsTable)
    .where(gte(blockedIpsTable.blocked_until, new Date()));

  const bySeverity = await db
    .select({
      severity: securityAlertsTable.severity,
      count: count(),
    })
    .from(securityAlertsTable)
    .where(gte(securityAlertsTable.created_at, twentyFourHoursAgo))
    .groupBy(securityAlertsTable.severity);

  const byType = await db
    .select({
      type: securityAlertsTable.type,
      count: count(),
    })
    .from(securityAlertsTable)
    .where(gte(securityAlertsTable.created_at, twentyFourHoursAgo))
    .groupBy(securityAlertsTable.type);

  const critCount = criticalAlerts24h?.count ?? 0;
  const highCount = bySeverity.find(b => b.severity === "high")?.count ?? 0;
  let threat_level: "critical" | "high" | "elevated" | "normal" = "normal";
  if (critCount > 0) threat_level = "critical";
  else if (highCount > 5) threat_level = "high";
  else if ((totalAlerts24h?.count ?? 0) > 20) threat_level = "elevated";

  res.json({
    threat_level,
    total_alerts_24h: totalAlerts24h?.count ?? 0,
    critical_alerts_24h: critCount,
    alerts_last_hour: alertsLastHour?.count ?? 0,
    blocked_ips: blockedCount?.count ?? 0,
    by_severity: bySeverity,
    by_type: byType,
  });
});

router.get("/blocked-ips", async (_req, res) => {
  const ips = await db
    .select()
    .from(blockedIpsTable)
    .orderBy(desc(blockedIpsTable.created_at))
    .limit(100);
  res.json(ips);
});

router.post("/block-ip", async (req, res) => {
  const { ip, reason, duration_hours } = req.body;
  if (!ip || !reason) {
    res.status(400).json({ error: "ip and reason are required" });
    return;
  }

  const blockedUntil = new Date(Date.now() + (duration_hours || 24) * 60 * 60 * 1000);

  const [blocked] = await db
    .insert(blockedIpsTable)
    .values({
      ip,
      reason,
      blocked_until: blockedUntil,
      auto_blocked: false,
      alert_count: 0,
    })
    .onConflictDoUpdate({
      target: blockedIpsTable.ip,
      set: {
        reason,
        blocked_until: blockedUntil,
        auto_blocked: false,
        updated_at: new Date(),
      },
    })
    .returning();

  logger.warn({ ip, reason }, "IP manually blocked");
  await auditLog("security", String(req.user?.id ?? "unknown"), "ip_blocked", {
    target_ip: ip,
    reason,
    duration_hours: duration_hours || 24,
    actor_email: req.user?.email,
  }, {
    ip_address: (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim() || req.socket.remoteAddress,
    user_agent: req.headers["user-agent"],
  });
  res.json(blocked);
});

router.delete("/blocked-ips/:ip", async (req, res) => {
  const { ip } = req.params;
  const [unblocked] = await db
    .delete(blockedIpsTable)
    .where(eq(blockedIpsTable.ip, ip))
    .returning();

  if (!unblocked) {
    res.status(404).json({ error: "IP not found in blocklist" });
    return;
  }

  logger.info({ ip }, "IP unblocked");
  await auditLog("security", String(req.user?.id ?? "unknown"), "ip_unblocked", {
    target_ip: ip,
    actor_email: req.user?.email,
  }, {
    ip_address: (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim() || req.socket.remoteAddress,
    user_agent: req.headers["user-agent"],
  });
  res.json({ message: "IP unblocked", ip });
});

router.post("/analyze", async (req, res) => {
  const { alert_ids } = req.body;

  let alerts;
  if (alert_ids && Array.isArray(alert_ids)) {
    alerts = await db
      .select()
      .from(securityAlertsTable)
      .where(sql`${securityAlertsTable.id} = ANY(${alert_ids})`);
  } else {
    alerts = await db
      .select()
      .from(securityAlertsTable)
      .where(eq(securityAlertsTable.status, "new"))
      .orderBy(desc(securityAlertsTable.created_at))
      .limit(20);
  }

  if (alerts.length === 0) {
    res.json({ message: "No alerts to analyze", analysis: null });
    return;
  }

  const analysis = await analyzeThreats(alerts);
  res.json({ alert_count: alerts.length, analysis });
});

router.patch("/alerts/:id/dismiss", async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const [alert] = await db
    .update(securityAlertsTable)
    .set({ status: "dismissed" })
    .where(eq(securityAlertsTable.id, id))
    .returning();

  if (!alert) {
    res.status(404).json({ error: "Alert not found" });
    return;
  }

  res.json(alert);
});

router.get("/notifications", async (_req, res) => {
  const limit = parseInt(_req.query.limit as string) || 50;
  const notifications = await getUnacknowledgedNotifications(limit);
  res.json(notifications);
});

router.patch("/notifications/:id/acknowledge", async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const user = req.user;
  const updated = await acknowledgeNotification(id, user?.email || "admin");
  if (!updated) {
    res.status(404).json({ error: "Notification not found or already acknowledged" });
    return;
  }
  res.json(updated);
});

router.post("/test-alert", async (req, res) => {
  const { severity, title, message } = req.body;
  await dispatchCriticalAlert(
    severity || "medium",
    title || "Test Alert",
    message || "This is a test security alert.",
  );
  res.json({ message: "Test alert dispatched" });
});

router.post("/webhook-config", async (req, res) => {
  const { webhook_url } = req.body;
  if (!webhook_url) {
    res.status(400).json({ error: "webhook_url is required" });
    return;
  }
  res.json({
    message: "Webhook URL configured. Set SECURITY_WEBHOOK_URL environment variable for persistent configuration.",
    webhook_url,
  });
});

export default router;
