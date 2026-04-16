import { db, securityNotificationsTable } from "@workspace/db";
import { eq, and, desc } from "drizzle-orm";
import { logger } from "./logger";

export interface AlertNotification {
  alert_id?: number;
  severity: string;
  title: string;
  message: string;
  channel?: string;
  webhook_url?: string;
}

const WEBHOOK_TIMEOUT = 5000;

export async function dispatchSecurityAlert(notification: AlertNotification): Promise<void> {
  try {
    const [record] = await db.insert(securityNotificationsTable).values({
      alert_id: notification.alert_id ?? null,
      severity: notification.severity,
      title: notification.title,
      message: notification.message,
      channel: notification.channel || "in_app",
      webhook_url: notification.webhook_url || null,
      delivered: false,
      acknowledged: false,
    }).returning();

    if (notification.webhook_url) {
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), WEBHOOK_TIMEOUT);
        const response = await fetch(notification.webhook_url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            type: "security_alert",
            severity: notification.severity,
            title: notification.title,
            message: notification.message,
            alert_id: notification.alert_id,
            timestamp: new Date().toISOString(),
          }),
          signal: controller.signal,
        });
        clearTimeout(timeout);

        if (response.ok) {
          await db.update(securityNotificationsTable)
            .set({ delivered: true })
            .where(eq(securityNotificationsTable.id, record.id));
        } else {
          logger.warn({ status: response.status, notificationId: record.id }, "Webhook delivery failed");
        }
      } catch {
        logger.warn({ notificationId: record.id }, "Webhook delivery error — notification saved for retry");
      }
    } else {
      await db.update(securityNotificationsTable)
        .set({ delivered: true })
        .where(eq(securityNotificationsTable.id, record.id));
    }
  } catch {
    logger.error("Failed to dispatch security notification");
  }
}

export async function dispatchCriticalAlert(severity: string, title: string, message: string, alertId?: number): Promise<void> {
  const webhookUrl = process.env.SECURITY_WEBHOOK_URL;
  await dispatchSecurityAlert({
    alert_id: alertId,
    severity,
    title,
    message,
    channel: webhookUrl ? "webhook" : "in_app",
    webhook_url: webhookUrl,
  });
}

export async function getUnacknowledgedNotifications(limit = 50) {
  return db.select()
    .from(securityNotificationsTable)
    .where(eq(securityNotificationsTable.acknowledged, false))
    .orderBy(desc(securityNotificationsTable.created_at))
    .limit(limit);
}

export async function acknowledgeNotification(id: number, acknowledgedBy: string) {
  const [updated] = await db.update(securityNotificationsTable)
    .set({ acknowledged: true, acknowledged_by: acknowledgedBy })
    .where(and(
      eq(securityNotificationsTable.id, id),
      eq(securityNotificationsTable.acknowledged, false),
    ))
    .returning();
  return updated;
}
