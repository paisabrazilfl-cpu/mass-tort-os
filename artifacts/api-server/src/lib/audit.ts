import { db, auditLogTable } from "@workspace/db";
import { logger } from "./logger";

export async function auditLog(
  entity_type: string,
  entity_id: string,
  action: string,
  details?: Record<string, unknown>,
  meta?: { ip_address?: string; user_agent?: string }
) {
  try {
    await db.insert(auditLogTable).values({
      entity_type,
      entity_id,
      action,
      details: details ?? {},
      ip_address: meta?.ip_address ?? null,
      user_agent: meta?.user_agent ?? null,
    });
  } catch (err) {
    logger.error({ err, entity_type, entity_id, action }, "Audit log write failed");
  }
}
