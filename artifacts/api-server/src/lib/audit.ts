import { db, auditLogTable } from "@workspace/db";
import { logger } from "./logger";

/**
 * Test-mode escape hatch (Task #10): the unit tests under
 * src/lib/__tests__/rbac.test.ts deliberately exercise dozens of denial
 * paths — each one fires off an audit insert. Letting those hit a real
 * pg pool keeps the event loop alive long after node:test has finished
 * its assertions and reports the file as "Promise resolution still pending".
 * When the test harness sets RBAC_DISABLE_AUDIT=1 we no-op cleanly.
 *
 * Production code never sets this flag and the boot env validator does not
 * check for it, so the only place it can be enabled is the test file itself.
 */
const AUDIT_DISABLED = process.env["RBAC_DISABLE_AUDIT"] === "1";

export async function auditLog(
  entity_type: string,
  entity_id: string,
  action: string,
  details?: Record<string, unknown>,
  meta?: { ip_address?: string; user_agent?: string }
) {
  if (AUDIT_DISABLED) return;
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
