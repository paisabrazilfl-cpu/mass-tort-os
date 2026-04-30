/**
 * Stripe billing adapter — single-firm shell for the MVI launch.
 *
 * All public functions are pure wrappers around the official Stripe SDK
 * with one job: hide credential resolution. Credentials live in the
 * integrations vault under preset `stripe` (api_key + client_secret).
 * `client_secret` carries the webhook signing secret (whsec_…) — Stripe
 * uses two different secrets and we keep both in the same vault row.
 *
 * Designed so every call site can do:
 *   const stripe = await getStripeClient();
 *   await stripe.checkout.sessions.create({...});
 *
 * No firm scoping yet — the MVI ships with a single firm. When we go
 * multi-tenant the resolver gains a `firmId` parameter that picks the
 * right vault row. For now we just take the first active stripe row.
 */
import Stripe from "stripe";
import { db, integrationsTable } from "@workspace/db";
import { and, eq } from "drizzle-orm";
import { getIntegrationCredentialsById } from "../../routes/integrations";
import { logger } from "../logger";

export interface StripeCredentials {
  apiKey: string;
  webhookSecret: string | null;
  integrationId: number;
}

/**
 * Resolve the active Stripe vault row. Returns null when no stripe
 * integration has been saved yet — callers should respond with a clear
 * 503 / config error rather than crashing.
 */
export async function loadStripeCredentials(): Promise<StripeCredentials | null> {
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
  const row = rows[0];
  if (!row) return null;

  const creds = await getIntegrationCredentialsById(row.id);
  if (!creds) return null;
  if (creds._decryption_errors && creds._decryption_errors.length) {
    logger.error(
      { fields: creds._decryption_errors, integration_id: row.id },
      "stripe credential decryption failed — re-enter the api_key",
    );
    return null;
  }

  const apiKey = typeof creds.api_key === "string" ? creds.api_key.trim() : "";
  if (!apiKey) return null;
  const webhookSecret =
    typeof creds.client_secret === "string" && creds.client_secret.trim().length > 0
      ? creds.client_secret.trim()
      : null;

  return { apiKey, webhookSecret, integrationId: row.id };
}

/**
 * Construct a Stripe SDK client from the active vault row. Throws when
 * stripe is not configured — callers in route handlers should catch and
 * convert to a 503 with a clear "Add a Stripe key on the Integrations
 * page" message.
 */
export async function getStripeClient(): Promise<Stripe> {
  const creds = await loadStripeCredentials();
  if (!creds) {
    throw new Error("Stripe is not configured. Add a Stripe API key on the Integrations page.");
  }
  return new Stripe(creds.apiKey);
}

export interface CheckoutSessionInput {
  firmId: number;
  priceId: string;
  successUrl: string;
  cancelUrl: string;
  customerEmail?: string | null;
  existingCustomerId?: string | null;
}

/**
 * Create a Checkout Session for a single-price subscription. Stamps the
 * firmId in client_reference_id and metadata so the webhook can resolve
 * back to the correct firms row even if the customer was created
 * outside our knowledge (e.g. operator typed an email Stripe already
 * had).
 */
export async function createCheckoutSession(
  input: CheckoutSessionInput,
): Promise<Stripe.Checkout.Session> {
  const stripe = await getStripeClient();
  const session = await stripe.checkout.sessions.create({
    mode: "subscription",
    line_items: [{ price: input.priceId, quantity: 1 }],
    success_url: input.successUrl,
    cancel_url: input.cancelUrl,
    client_reference_id: String(input.firmId),
    customer: input.existingCustomerId ?? undefined,
    customer_email: input.existingCustomerId ? undefined : input.customerEmail ?? undefined,
    metadata: { firm_id: String(input.firmId) },
    subscription_data: { metadata: { firm_id: String(input.firmId) } },
  });
  return session;
}

export async function createPortalSession(
  customerId: string,
  returnUrl: string,
): Promise<Stripe.BillingPortal.Session> {
  const stripe = await getStripeClient();
  return stripe.billingPortal.sessions.create({
    customer: customerId,
    return_url: returnUrl,
  });
}

/**
 * Verify a Stripe webhook payload against the signing secret stored in
 * `client_secret` of the stripe vault row. Throws on invalid signatures
 * — webhook handlers must catch and respond 400.
 */
export async function verifyWebhook(
  rawBody: Buffer,
  signature: string,
): Promise<Stripe.Event> {
  const creds = await loadStripeCredentials();
  if (!creds) throw new Error("Stripe is not configured");
  if (!creds.webhookSecret) {
    throw new Error("Stripe webhook signing secret missing — set client_secret on the stripe integration");
  }
  const stripe = new Stripe(creds.apiKey);
  return stripe.webhooks.constructEvent(rawBody, signature, creds.webhookSecret);
}

export async function listInvoices(customerId: string, limit = 10): Promise<Stripe.Invoice[]> {
  const stripe = await getStripeClient();
  const result = await stripe.invoices.list({ customer: customerId, limit });
  return result.data;
}
