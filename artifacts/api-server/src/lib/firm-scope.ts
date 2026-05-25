// Firm-scoping helpers. The single-firm shell (rbac.ts) guarantees every
// authenticated user carries `req.user.firm_id`, and the firmContextMiddleware
// upstream rejects any request whose JWT lacks that claim. These helpers
// centralize the read so every route reaches for firm_id the same way and a
// future audit can `grep requireFirmId` to find the boundary.
//
// Why this exists: the historical leads/cases/analytics routes built WHERE
// clauses without firm_id, which leaked PII across tenants. The fix is to
// always AND `eq(<table>.firm_id, requireFirmId(req))` into every query that
// touches firm-scoped data. Re-exported `eq` keeps imports tight at call sites.
import type { Request } from "express";
import { eq } from "drizzle-orm";
import { leadsTable } from "@workspace/db";

export class MissingFirmContextError extends Error {
  constructor() {
    super("req.user.firm_id is missing — authMiddleware/firmContextMiddleware must run first");
    this.name = "MissingFirmContextError";
  }
}

/**
 * Read the caller's firm_id off the request. Throws if absent — that means
 * the middleware chain was misconfigured for this route and the request must
 * NOT proceed (the alternative is a cross-tenant query). Callers should let
 * this bubble; the express error handler returns 500 and the boot-time route
 * protection validator (`lib/route-protection.ts`) catches the misconfig in CI.
 */
export function requireFirmId(req: Request): number {
  const firmId = req.user?.firm_id;
  if (typeof firmId !== "number") throw new MissingFirmContextError();
  return firmId;
}

/** Drizzle predicate: `leads.firm_id = <caller's firm>`. */
export function leadFirmScope(req: Request) {
  return eq(leadsTable.firm_id, requireFirmId(req));
}
