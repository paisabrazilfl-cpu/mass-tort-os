import { db, auditLogTable } from "@workspace/db";
import { logger } from "./logger";

// Test-mode escape hatch: when RBAC_DISABLE_AUDIT=1 the audit insert is
// a no-op so unit tests that exercise denial paths don't hold the pg pool
// open past assertion time. Honoured ONLY in non-production / non-staging
// — production-like processes ignore the flag and log a warning so an
// accidental misconfiguration is greppable instead of silent.
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
  meta?: { ip_address?: string; user_agent?: string; firm_id?: number | null }
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
      firm_id: meta?.firm_id ?? null,
    });
  } catch (err) {
    logger.error({ err, entity_type, entity_id, action }, "Audit log write failed");
  }
}
