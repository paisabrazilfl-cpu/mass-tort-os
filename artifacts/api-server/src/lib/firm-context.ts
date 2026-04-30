// Loads req.firm from the firm_id stamped on req.user by the auth
// middleware. Mounted immediately after authMiddleware in routes/index.ts
// so every authenticated route can rely on req.firm.firm_id (cheap, also
// gives downstream code typed access to subscription_status without a
// second DB hop in routes that already need the firm row).
//
// Failure modes:
// - Missing req.user → 401 (auth mw should have already short-circuited;
//   defense-in-depth in case some future route is misconfigured).
// - firm row not found → 401 with firm_not_found audit (the user's JWT
//   firm_id claim points at a row that no longer exists; force re-login).
import type { Request, Response, NextFunction } from "express";
import { db, firmsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { logger } from "./logger";
import { auditLog } from "./audit";

// Mirror of rbac.ts#auditDenial but scoped to this middleware's failure
// modes. Fire-and-forget — audit failures must never escalate a 401 to a
// 500. Subject = user_id when known, "anonymous" otherwise.
function auditFirmContextDenial(req: Request, reason: string): void {
  const u = req.user;
  const subject = typeof u?.id === "number" ? String(u.id) : "anonymous";
  const xff = req.headers["x-forwarded-for"];
  const ip =
    (Array.isArray(xff) ? xff[0] : xff)?.split(",")[0]?.trim() ||
    req.socket.remoteAddress;
  void auditLog(
    "access_denied",
    subject,
    reason,
    {
      reason,
      path: req.path,
      method: req.method,
      user_id: u?.id ?? null,
      user_email: u?.email ?? null,
      user_role: u?.role ?? null,
      claimed_firm_id: u?.firm_id ?? null,
    },
    {
      ip_address: ip,
      user_agent: req.headers["user-agent"] as string | undefined,
    },
  ).catch(() => {
    /* never throw out of audit */
  });
}

export async function firmContextMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  if (!req.user) {
    auditFirmContextDenial(req, "firm_context_no_user");
    res.status(401).json({ error: "Authentication required" });
    return;
  }
  const firmId = req.user.firm_id;
  if (typeof firmId !== "number") {
    logger.error(
      { user_id: req.user.id, path: req.path },
      "firmContextMiddleware: req.user missing firm_id (auth mw bug)",
    );
    auditFirmContextDenial(req, "firm_context_missing_claim");
    res.status(401).json({ error: "Token missing firm context — please re-login" });
    return;
  }

  const rows = await db
    .select({
      id: firmsTable.id,
      name: firmsTable.name,
      slug: firmsTable.slug,
      subscription_status: firmsTable.subscription_status,
      current_period_end: firmsTable.current_period_end,
    })
    .from(firmsTable)
    .where(eq(firmsTable.id, firmId))
    .limit(1);

  if (!rows[0]) {
    logger.warn(
      { user_id: req.user.id, firm_id: firmId, path: req.path },
      "firmContextMiddleware: firm row not found for token claim",
    );
    auditFirmContextDenial(req, "firm_context_not_found");
    res.status(401).json({ error: "Firm not found — please re-login" });
    return;
  }

  req.firm = {
    id: rows[0].id,
    name: rows[0].name,
    slug: rows[0].slug,
    subscription_status: rows[0].subscription_status,
    current_period_end: rows[0].current_period_end,
  };
  next();
}
