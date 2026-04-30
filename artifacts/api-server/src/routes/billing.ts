/**
 * Billing routes — checkout, portal, state, invoices.
 *
 * Single-firm shell for MVI: the user's firm is resolved from
 * mtos_users.firm_id, not URL parameters. Multi-firm scoping is a
 * follow-up — at that point this router takes a `:firmId` segment and
 * the resolver checks membership.
 *
 * All endpoints (except the webhook in routes/webhooks.ts) require
 * BILLING_MANAGE permission. Operators can still see plain-data
 * subscription state via /state on a viewer-level token? No — the
 * task spec says billing.manage gates everything. Viewers see "billing
 * is managed by your administrator" client-side.
 */
import { Router } from "express";
import { z } from "zod/v4";
import { db, firmsTable, usersTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { requirePermission, authMiddleware, Permission } from "../lib/rbac";
import {
  createCheckoutSession,
  createPortalSession,
  listInvoices,
  loadStripeCredentials,
} from "../lib/payments/stripe";
import { logger } from "../lib/logger";
import { badRequest } from "../lib/http-errors";

const router = Router();

async function getFirmForUser(userId: number) {
  if (userId <= 0) {
    // Dev bypass — pick the default firm.
    const rows = await db
      .select()
      .from(firmsTable)
      .where(eq(firmsTable.slug, "default"))
      .limit(1);
    return rows[0] ?? null;
  }
  const userRows = await db
    .select({ firm_id: usersTable.firm_id })
    .from(usersTable)
    .where(eq(usersTable.id, userId))
    .limit(1);
  const firmId = userRows[0]?.firm_id;
  if (!firmId) return null;
  const firmRows = await db.select().from(firmsTable).where(eq(firmsTable.id, firmId)).limit(1);
  return firmRows[0] ?? null;
}

router.get(
  "/state",
  requirePermission(Permission.BILLING_MANAGE),
  async (req, res) => {
    const firm = await getFirmForUser(req.user!.id);
    if (!firm) {
      res.status(404).json({ status: "error", message: "No firm linked to user" });
      return;
    }
    const stripeConfigured = (await loadStripeCredentials()) !== null;
    res.json({
      status: "ok",
      data: {
        firm_id: firm.id,
        firm_name: firm.name,
        stripe_configured: stripeConfigured,
        stripe_customer_id: firm.stripe_customer_id,
        stripe_subscription_id: firm.stripe_subscription_id,
        subscription_status: firm.subscription_status,
        current_period_end: firm.current_period_end,
        plan_price_id: firm.plan_price_id,
      },
    });
  },
);

// /firm-status — minimal subscription posture readable by ANY authenticated
// user in the firm. Powers the global in-app billing banner that warns
// every operator (not just admins) when their firm is past_due / canceled
// / unpaid so write actions visibly fail with context. Returns ONLY the
// non-sensitive status + period end; Stripe IDs stay behind BILLING_MANAGE
// on /state.
router.get("/firm-status", authMiddleware, async (req, res) => {
  const firm = await getFirmForUser(req.user!.id);
  if (!firm) {
    res.json({
      status: "ok",
      data: { subscription_status: null, current_period_end: null, has_firm: false },
    });
    return;
  }
  res.json({
    status: "ok",
    data: {
      subscription_status: firm.subscription_status,
      current_period_end: firm.current_period_end,
      has_firm: true,
    },
  });
});

const checkoutSchema = z.object({
  price_id: z.string().min(1),
  success_url: z.string().url(),
  cancel_url: z.string().url(),
});

router.post(
  "/checkout",
  requirePermission(Permission.BILLING_MANAGE),
  async (req, res) => {
    const parsed = checkoutSchema.safeParse(req.body);
    if (!parsed.success) {
      badRequest(res, "Invalid checkout payload", parsed.error.issues);
      return;
    }
    const firm = await getFirmForUser(req.user!.id);
    if (!firm) {
      res.status(404).json({ status: "error", message: "No firm linked to user" });
      return;
    }
    try {
      const session = await createCheckoutSession({
        firmId: firm.id,
        priceId: parsed.data.price_id,
        successUrl: parsed.data.success_url,
        cancelUrl: parsed.data.cancel_url,
        customerEmail: firm.billing_email,
        existingCustomerId: firm.stripe_customer_id,
      });
      res.json({ status: "ok", data: { url: session.url, session_id: session.id } });
    } catch (err) {
      logger.error({ err, firm_id: firm.id }, "stripe checkout failed");
      res.status(503).json({
        status: "error",
        code: "STRIPE_UNAVAILABLE",
        message: err instanceof Error ? err.message : "Stripe unavailable",
      });
    }
  },
);

const portalSchema = z.object({
  return_url: z.string().url(),
});

router.post(
  "/portal",
  requirePermission(Permission.BILLING_MANAGE),
  async (req, res) => {
    const parsed = portalSchema.safeParse(req.body);
    if (!parsed.success) {
      badRequest(res, "Invalid portal payload", parsed.error.issues);
      return;
    }
    const firm = await getFirmForUser(req.user!.id);
    if (!firm?.stripe_customer_id) {
      res.status(400).json({
        status: "error",
        code: "NO_STRIPE_CUSTOMER",
        message: "This firm has no Stripe customer yet. Subscribe first.",
      });
      return;
    }
    try {
      const session = await createPortalSession(firm.stripe_customer_id, parsed.data.return_url);
      res.json({ status: "ok", data: { url: session.url } });
    } catch (err) {
      logger.error({ err, firm_id: firm.id }, "stripe portal failed");
      res.status(503).json({
        status: "error",
        code: "STRIPE_UNAVAILABLE",
        message: err instanceof Error ? err.message : "Stripe unavailable",
      });
    }
  },
);

router.get(
  "/invoices",
  requirePermission(Permission.BILLING_MANAGE),
  async (req, res) => {
    const firm = await getFirmForUser(req.user!.id);
    if (!firm) {
      res.status(404).json({ status: "error", message: "No firm linked to user" });
      return;
    }
    if (!firm.stripe_customer_id) {
      res.json({ status: "ok", data: [] });
      return;
    }
    try {
      const invoices = await listInvoices(firm.stripe_customer_id, 10);
      res.json({
        status: "ok",
        data: invoices.map((inv) => ({
          id: inv.id,
          number: inv.number,
          status: inv.status,
          amount_due: inv.amount_due,
          amount_paid: inv.amount_paid,
          currency: inv.currency,
          created: inv.created,
          period_start: inv.period_start,
          period_end: inv.period_end,
          hosted_invoice_url: inv.hosted_invoice_url,
          invoice_pdf: inv.invoice_pdf,
        })),
      });
    } catch (err) {
      logger.error({ err, firm_id: firm.id }, "stripe invoices fetch failed");
      res.status(503).json({
        status: "error",
        code: "STRIPE_UNAVAILABLE",
        message: err instanceof Error ? err.message : "Stripe unavailable",
      });
    }
  },
);

export default router;
