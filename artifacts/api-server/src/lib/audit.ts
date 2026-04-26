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
 * SAFETY: this flag is honoured ONLY when NODE_ENV is NOT one of
 * `production` / `staging` (i.e., it is gated to dev / test contexts).
 * If someone accidentally sets RBAC_DISABLE_AUDIT=1 in a deployed
 * environment, the gate refuses to suppress audit writes and the flag
 * is a no-op. We log a warning at module-load time so ops can grep
 * for the misconfiguration.
 */
const NODE_ENV_FOR_AUDIT = process.env["NODE_ENV"];
const IS_PROD_LIKE_FOR_AUDIT = NODE_ENV_FOR_AUDIT === "production" || NODE_ENV_FOR_AUDIT === "staging";
const AUDIT_DISABLE_REQUESTED = process.env["RBAC_DISABLE_AUDIT"] === "1";
const AUDIT_DISABLED = AUDIT_DISABLE_REQUESTED && !IS_PROD_LIKE_FOR_AUDIT;
if (AUDIT_DISABLE_REQUESTED && IS_PROD_LIKE_FOR_AUDIT) {
  // Loud, visible warning. Do NOT throw — audit is best-effort and we
  // don't want a misconfigured env var to take down the whole API. But
  // we want this to scream in the logs.
  logger.warn(
    { node_env: NODE_ENV_FOR_AUDIT },
    "RBAC_DISABLE_AUDIT=1 is IGNORED in production/staging — audit writes remain enabled",
  );
}

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
