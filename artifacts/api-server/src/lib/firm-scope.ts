import { Request } from "express";

/**
 * Extracts and validates the firm_id from the request.
 * Every firm-scoped query MUST use this helper to ensure multi-tenant isolation.
 * The firm_id is typically populated by the firmContextMiddleware on req.firm.id.
 *
 * @param req The Express request object.
 * @returns The firm_id as a number.
 * @throws Error if req.firm.id is missing or not a number.
 */
export function requireFirmId(req: Request): number {
  const firmId = req.firm?.id;
  if (typeof firmId !== "number") {
    // This should generally not happen if firmContextMiddleware is correctly
    // placed in the middleware chain before firm-scoped routes.
    throw new Error("Multi-tenancy violation: req.firm.id is missing or invalid");
  }
  return firmId;
}
