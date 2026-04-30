/**
 * verify-stripe.ts — operator script that proves the saved Stripe creds
 * actually work end-to-end.
 *
 * Two-phase verification:
 *   1) LIVE API   — decrypt vault, hit balance.retrieve() + prices.list()
 *                   so a human can see HTTP 200 (or a clear failure)
 *                   before trusting the adapter.
 *   2) WEBHOOK    — boot the express app in-process and POST a synthetic
 *                   `customer.subscription.updated` event to
 *                   /api/webhooks/stripe with a real Stripe signature.
 *                   Asserts the firms row updates AND that an invalid
 *                   signature is rejected.
 *
 *   pnpm --filter @workspace/api-server exec tsx \
 *     src/scripts/verify-stripe.ts <integration_id>
 *
 * Exit codes:
 *   0 — both phases pass; the adapter is fully wired
 *   1 — credentials decrypted but a check failed (live or webhook)
 *   2 — usage error / row not found / wrong provider
 */
import Stripe from "stripe";
import crypto from "crypto";
import type { AddressInfo } from "node:net";
import { db, integrationsTable as integrations, firmsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { getIntegrationCredentialsById } from "../routes/integrations.js";

async function liveApiPhase(apiKey: string, webhookSecret: string): Promise<void> {
  const stripe = new Stripe(apiKey);

  console.log(`[1/4] stripe.balance.retrieve()`);
  const t0 = Date.now();
  let balance: Stripe.Balance;
  try {
    balance = await stripe.balance.retrieve();
  } catch (err) {
    console.error(`     -> FAILED in ${Date.now() - t0}ms`);
    console.error("Stripe rejected the api_key:", err instanceof Error ? err.message : err);
    process.exit(1);
  }
  console.log(`     -> OK in ${Date.now() - t0}ms`);
  const totals = balance.available.map((b) => `${(b.amount / 100).toFixed(2)} ${b.currency.toUpperCase()}`).join(", ");
  console.log(`     livemode=${balance.livemode ? "LIVE" : "test"} available=[${totals}]`);

  console.log(`[2/4] stripe.prices.list({ limit: 3 })`);
  const t1 = Date.now();
  let prices: Stripe.ApiList<Stripe.Price>;
  try {
    prices = await stripe.prices.list({ limit: 3, active: true });
  } catch (err) {
    console.error(`     -> FAILED in ${Date.now() - t1}ms`);
    console.error("Could not list prices:", err instanceof Error ? err.message : err);
    process.exit(1);
  }
  console.log(`     -> OK in ${Date.now() - t1}ms (${prices.data.length} active prices)`);
  for (const p of prices.data) {
    const amt = p.unit_amount != null ? `${(p.unit_amount / 100).toFixed(2)} ${p.currency.toUpperCase()}` : "—";
    console.log(`       ${p.id} ${amt} ${p.recurring ? `every ${p.recurring.interval}` : "(one-time)"}`);
  }
  void webhookSecret;
}

async function webhookPhase(webhookSecret: string): Promise<void> {
  // Boot the app in-process (mirrors src/lib/__tests__/rbac-route-matrix.test.ts).
  const appMod = (await import("../app.js")) as { default: import("express").Express };
  const app = appMod.default;

  const server = await new Promise<import("node:http").Server>((resolve, reject) => {
    const s = app.listen(0, () => resolve(s));
    s.on("error", reject);
  });
  const addr = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${addr.port}`;

  const TS = Date.now();
  const customerId = `cus_verify_stripe_${TS}`;
  const subscriptionId = `sub_verify_stripe_${TS}`;
  const slug = `verify-stripe-${TS}`;
  let firmId: number | null = null;

  try {
    // Insert a temp firm anchored to the synthetic Stripe customer id.
    const inserted = await db
      .insert(firmsTable)
      .values({
        name: `verify-stripe ${TS}`,
        slug,
        stripe_customer_id: customerId,
        stripe_subscription_id: subscriptionId,
        subscription_status: "canceled",
      })
      .returning({ id: firmsTable.id });
    firmId = inserted[0]?.id ?? null;
    if (!firmId) throw new Error("could not insert verify-stripe firm");
    console.log(`[3/4] inserted temp firm id=${firmId} cust=${customerId}`);

    // Build a `customer.subscription.updated` event that anchors on our
    // customer + sub ids, with status=active so the handler flips the
    // firms row from canceled → active.
    const periodEnd = Math.floor(Date.now() / 1000) + 86_400 * 30;
    const event = {
      id: `evt_verify_${TS}`,
      object: "event",
      api_version: "2024-04-10",
      created: Math.floor(Date.now() / 1000),
      type: "customer.subscription.updated",
      data: {
        object: {
          id: subscriptionId,
          object: "subscription",
          customer: customerId,
          status: "active",
          current_period_end: periodEnd,
          metadata: { firm_id: String(firmId) },
          items: {
            data: [
              {
                id: `si_verify_${TS}`,
                price: { id: "price_verify_stripe", recurring: { interval: "month" } },
                current_period_end: periodEnd,
              },
            ],
          },
        },
      },
    };
    const rawBody = JSON.stringify(event);

    // Use Stripe SDK's helper so the signature matches constructEvent's expectations.
    const sigHeader = Stripe.webhooks.generateTestHeaderString({
      payload: rawBody,
      secret: webhookSecret,
    });

    const okRes = await fetch(`${baseUrl}/api/webhooks/stripe`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Stripe-Signature": sigHeader },
      body: rawBody,
    });
    const okBody = (await okRes.json()) as { ok?: boolean; received?: string; note?: string };
    console.log(`     -> POST /api/webhooks/stripe ${okRes.status} body=${JSON.stringify(okBody)}`);
    if (okRes.status !== 200 || okBody.received !== "customer.subscription.updated") {
      throw new Error(`webhook rejected the valid event: status=${okRes.status} body=${JSON.stringify(okBody)}`);
    }

    // Re-read the firm row and assert subscription_status flipped to "active".
    const [firmAfter] = await db
      .select()
      .from(firmsTable)
      .where(eq(firmsTable.id, firmId));
    if (firmAfter?.subscription_status !== "active") {
      throw new Error(
        `firm subscription_status did not advance: expected "active", got "${firmAfter?.subscription_status}"`,
      );
    }
    console.log(`     OK firms.subscription_status="active" period_end=${firmAfter.current_period_end?.toISOString()}`);

    // Negative path — same payload, mangled signature. The Stripe webhook
    // handler always returns HTTP 200 (Stripe stops retrying then), but the
    // body's `note` field flips to "invalid_signature" and the firm row
    // stays put. Both must hold.
    console.log(`[4/4] negative test: invalid Stripe-Signature header must NOT mutate firm`);
    // Reset state so we can prove the bad-sig POST didn't apply the event.
    await db
      .update(firmsTable)
      .set({ subscription_status: "canceled" })
      .where(eq(firmsTable.id, firmId));
    const badRes = await fetch(`${baseUrl}/api/webhooks/stripe`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Stripe-Signature": "t=0,v1=deadbeef" },
      body: rawBody,
    });
    const badBody = (await badRes.json()) as { note?: string };
    console.log(`     -> POST (bad sig) ${badRes.status} body=${JSON.stringify(badBody)}`);
    if (badRes.status !== 200 || badBody.note !== "invalid_signature") {
      throw new Error(`bad-signature path did not return note=invalid_signature: ${JSON.stringify(badBody)}`);
    }
    const [firmStill] = await db
      .select()
      .from(firmsTable)
      .where(eq(firmsTable.id, firmId));
    if (firmStill?.subscription_status === "active") {
      throw new Error("bad-signature event mutated firms.subscription_status — webhook is NOT verifying");
    }
    console.log(`     OK firm stayed at "${firmStill?.subscription_status}"; bad-sig event rejected`);
  } finally {
    if (firmId !== null) {
      await db.delete(firmsTable).where(eq(firmsTable.id, firmId));
    }
    await new Promise<void>((res) => server.close(() => res()));
  }
}

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
  // Webhook secret is a hard requirement — see header comment.
  if (!webhookSecret) {
    console.error("FAIL: no client_secret set — webhook signature verification cannot run in prod.");
    console.error("       (set the Stripe webhook signing secret as `client_secret` on this integration row before re-verifying)");
    process.exit(1);
  }
  if (!webhookSecret.startsWith("whsec_")) {
    console.error(`FAIL: client_secret does not look like a webhook secret (expected whsec_..., got ${webhookSecret.slice(0, 6)}...).`);
    process.exit(1);
  }

  await liveApiPhase(apiKey, webhookSecret);
  await webhookPhase(webhookSecret);

  console.log("\nRESULT: Stripe credentials are LIVE and the webhook applies events end-to-end.");
  // Belt-and-suspenders: keep the crypto import live so a future refactor
  // that imports it for replay-protection ergonomics doesn't tree-shake
  // it out of the build.
  void crypto;
  process.exit(0);
}

main().catch((err) => {
  console.error("FATAL:", err);
  process.exit(1);
});
