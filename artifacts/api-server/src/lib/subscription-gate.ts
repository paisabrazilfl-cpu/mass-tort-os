/**
 * Subscription gate — runtime middleware that blocks write requests
 * when the current user's firm does not have an active subscription.
 *
 * Activation rules (intentional, single-firm MVI):
 *   1. GET / HEAD / OPTIONS always pass — read-only access stays free
 *      so an operator whose card expired can still inspect their data.
 *   2. If no stripe vault row exists at all, the gate is disabled —
 *      self-hosted users without Stripe set up can keep working.
 *   3. If Stripe IS configured AND the firm's subscription_status is
 *      not in ("active","trialing","past_due"), writes 402.
 *      "past_due" is intentionally allowed — Stripe gives a grace
 *      window during which retries happen, and locking out a paying
 *      customer mid-payment-retry is hostile.
 *   4. `MTOS_DISABLE_BILLING_GATE=1` short-circuits everything — used
 *      in CI / e2e tests so we don't need to mock Stripe state.
 *
 * Wired AFTER authMiddleware so req.user is populated. Routes that
 * should bypass the gate entirely (the billing routes themselves, the
 * integrations page so they can save the Stripe key) are excluded by
 * path-prefix below.
 */
import type { Request, Response, NextFunction } from "express";
import { db, firmsTable, integrationsTable, usersTable } from "@workspace/db";
import { and, eq } from "drizzle-orm";
import { logger } from "./logger";

const ALLOWED_STATUSES = new Set(["active", "trialing", "past_due"]);

/**
 * Path prefixes that bypass the gate. These must remain reachable even
 * for an unsubscribed firm — otherwise the operator can't actually
 * subscribe (chicken-and-egg).
 */
const BYPASS_PREFIXES = [
  "/billing/",      // checkout, portal, state — needed to start/manage subscription
  "/integrations",  // operator must be able to save the Stripe key
  "/auth/",         // never gate auth
  "/health",        // monitoring
];

let cachedStripeConfigured: boolean | null = null;
let cachedAt = 0;
const CACHE_TTL_MS = 30_000;

async function isStripeConfigured(): Promise<boolean> {
  if (cachedStripeConfigured !== null && Date.now() - cachedAt < CACHE_TTL_MS) {
    return cachedStripeConfigured;
  }
  try {
    const rows = await db
      .select({ id: integrationsTable.id })
      .from(integrationsTable)
      .where(
        and(
          eq(integrationsTable.provider, "stripe"),
          eq(integrationsTable.status, "active"),
        ),
      )
      .limit(1);
    cachedStripeConfigured = rows.length > 0;
  } catch (err) {
    logger.warn({ err }, "subscription-gate: stripe configured check failed; treating as unconfigured");
    cachedStripeConfigured = false;
  }
  cachedAt = Date.now();
  return cachedStripeConfigured;
}

export function invalidateStripeConfiguredCache() {
  cachedStripeConfigured = null;
  cachedAt = 0;
}

export async function getFirmIdForUser(userId: number): Promise<number | null> {
  if (userId <= 0) return null; // dev bypass user
  const rows = await db
    .select({ firm_id: usersTable.firm_id })
    .from(usersTable)
    .where(eq(usersTable.id, userId))
    .limit(1);
  return rows[0]?.firm_id ?? null;
}

export async function subscriptionGateMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  // Read-only methods bypass.
  const method = req.method.toUpperCase();
  if (method === "GET" || method === "HEAD" || method === "OPTIONS") {
    next();
    return;
  }

  if (process.env.MTOS_DISABLE_BILLING_GATE === "1") {
    next();
    return;
  }

  // Path-prefix bypass.
  const path = req.path || "";
  for (const prefix of BYPASS_PREFIXES) {
    if (path.startsWith(prefix)) {
      next();
      return;
    }
  }

  // No stripe → gate disabled.
  if (!(await isStripeConfigured())) {
    next();
    return;
  }

  const user = req.user;
  if (!user || user.id <= 0) {
    // Dev bypass user — no firm membership; let the request through.
    next();
    return;
  }

  const firmId = await getFirmIdForUser(user.id);
  if (!firmId) {
    // User has no firm — fail closed since this is a misconfiguration.
    res.status(402).json({
      status: "error",
      code: "NO_FIRM",
      message: "User account is not linked to a firm. Contact an administrator.",
    });
    return;
  }

  const firmRows = await db
    .select({
      subscription_status: firmsTable.subscription_status,
      current_period_end: firmsTable.current_period_end,
    })
    .from(firmsTable)
    .where(eq(firmsTable.id, firmId))
    .limit(1);
  const firm = firmRows[0];
  if (!firm) {
    res.status(402).json({
      status: "error",
      code: "FIRM_NOT_FOUND",
      message: "Firm record missing. Contact an administrator.",
    });
    return;
  }

  if (!ALLOWED_STATUSES.has(firm.subscription_status)) {
    res.status(402).json({
      status: "error",
      code: "SUBSCRIPTION_REQUIRED",
      message: "An active subscription is required to make changes. Visit Billing to subscribe.",
      subscription_status: firm.subscription_status,
    });
    return;
  }

  next();
}
