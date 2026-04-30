/**
 * verify-stripe.ts — operator script that proves the saved Stripe creds
 * actually work end-to-end. Mirrors verify-docusign.ts: take an
 * integration row id, decrypt the vault, then make two read-only API
 * calls so a human can see HTTP 200s (or a clear failure) before
 * trusting the adapter. Designed to be run from the project root, e.g.
 *
 *   pnpm --filter @workspace/api-server exec tsx \
 *     src/scripts/verify-stripe.ts <integration_id>
 *
 * Exit codes:
 *   0 — both API calls succeeded; the key is live
 *   1 — credentials decrypted but Stripe rejected them (or webhook
 *       secret missing — that is a hard requirement for prod)
 *   2 — usage error / row not found / wrong provider
 */
import Stripe from "stripe";
import { db, integrationsTable as integrations } from "@workspace/db";
import { eq } from "drizzle-orm";
import { getIntegrationCredentialsById } from "../routes/integrations.js";

async function main() {
  const id = Number(process.argv[2]);
  if (!Number.isInteger(id) || id <= 0) {
    console.error("Usage: tsx verify-stripe.ts <integration_id>");
    process.exit(2);
  }

  const [row] = await db.select().from(integrations).where(eq(integrations.id, id));
  if (!row) {
    console.error(`No integration row with id=${id}`);
    process.exit(2);
  }
  if (row.provider !== "stripe") {
    console.error(`Row ${id} is provider=${row.provider}, expected stripe`);
    process.exit(2);
  }

  const creds = await getIntegrationCredentialsById(id);
  if (!creds) {
    console.error("No credentials retrievable");
    process.exit(1);
  }
  if (creds._decryption_errors?.length) {
    console.error("Decryption errors:", creds._decryption_errors);
    process.exit(1);
  }

  const apiKey = creds.api_key as string | undefined;
  const webhookSecret = creds.client_secret as string | undefined;

  if (!apiKey) {
    console.error("Missing api_key after decrypt");
    process.exit(1);
  }
  if (!apiKey.startsWith("sk_")) {
    console.error(`api_key does not look like a Stripe secret key (expected sk_..., got ${apiKey.slice(0, 4)}...)`);
    process.exit(1);
  }

  // Webhook secret is a hard requirement. Stripe POSTs subscription
  // updates to /api/webhooks/stripe and the adapter REJECTS deliveries
  // without a valid `whsec_...` secret — meaning checkout would
  // succeed, but `firms.subscription_status` would never advance to
  // "active" and the subscription gate would block all writes. Refusing
  // to declare LIVE here keeps the operator from shipping that gap.
  if (!webhookSecret) {
    console.error("FAIL: no client_secret set — webhook signature verification cannot run in prod.");
    console.error("       (set the Stripe webhook signing secret as `client_secret` on this integration row before re-verifying)");
    process.exit(1);
  }
  if (!webhookSecret.startsWith("whsec_")) {
    console.error(`FAIL: client_secret does not look like a webhook secret (expected whsec_..., got ${webhookSecret.slice(0, 6)}...).`);
    process.exit(1);
  }

  // Match the adapter (lib/payments/stripe.ts) — let the SDK pin its
  // own pinned API version so verification fails the same way prod does.
  const stripe = new Stripe(apiKey);

  // `balance.retrieve()` is the cheapest authenticated read in the API
  // and works for every account type (standard, express, custom). A 401
  // here means the api_key is bad; anything else means it is live.
  console.log(`[1/2] stripe.balance.retrieve()`);
  const t0 = Date.now();
  let balance: Stripe.Balance;
  try {
    balance = await stripe.balance.retrieve();
  } catch (err) {
    const ms = Date.now() - t0;
    console.error(`     -> FAILED in ${ms}ms`);
    console.error("Stripe rejected the api_key:", err instanceof Error ? err.message : err);
    process.exit(1);
  }
  const balanceMs = Date.now() - t0;
  console.log(`     -> OK in ${balanceMs}ms`);
  const totals = balance.available.map((b) => `${(b.amount / 100).toFixed(2)} ${b.currency.toUpperCase()}`).join(", ");
  console.log(`     livemode=${balance.livemode ? "LIVE" : "test"} available=[${totals}]`);

  console.log(`[2/2] stripe.prices.list({ limit: 3 })`);
  const t1 = Date.now();
  let prices: Stripe.ApiList<Stripe.Price>;
  try {
    prices = await stripe.prices.list({ limit: 3, active: true });
  } catch (err) {
    const ms = Date.now() - t1;
    console.error(`     -> FAILED in ${ms}ms`);
    console.error("Could not list prices:", err instanceof Error ? err.message : err);
    process.exit(1);
  }
  const pricesMs = Date.now() - t1;
  console.log(`     -> OK in ${pricesMs}ms (${prices.data.length} active price${prices.data.length === 1 ? "" : "s"} returned)`);
  for (const p of prices.data) {
    const amt = p.unit_amount != null ? `${(p.unit_amount / 100).toFixed(2)} ${p.currency.toUpperCase()}` : "—";
    console.log(`       ${p.id} ${amt} ${p.recurring ? `every ${p.recurring.interval}` : "(one-time)"}`);
  }

  console.log("\nRESULT: Stripe credentials are LIVE. Adapter can create checkout sessions and read invoices.");
  process.exit(0);
}

main().catch((err) => {
  console.error("FATAL:", err);
  process.exit(1);
});
