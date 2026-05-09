/**
 * Smoke test for the generic outbound event dispatcher (Task #52).
 *
 * Verifies:
 *  - Only integrations whose `subscribed_events` includes the event name
 *    receive a delivery.
 *  - Non-matching subscriptions are silently skipped.
 *  - Default subscription (no userConfig set) receives `lead.created`.
 *  - Envelope headers (X-MTOS-Event, X-MTOS-Delivery) are present.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { db, integrationsTable, firmsTable, usersTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { dispatchEvent } from "../event-dispatcher";

interface Hit { url: string; headers: Record<string, string | string[] | undefined>; body: string; }

function startCollector(): Promise<{ url: string; hits: Hit[]; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const hits: Hit[] = [];
    const server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        hits.push({ url: req.url ?? "", headers: req.headers, body: Buffer.concat(chunks).toString("utf8") });
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end("{}");
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (typeof addr !== "object" || addr === null) throw new Error("listen() did not return AddressInfo");
      resolve({
        url: `http://127.0.0.1:${addr.port}`,
        hits,
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}

const TAG = "evt-dispatcher-test";

interface SeedIds { firmId: number; userId: number; leadCreatedOnly: number; ocrOnly: number; defaultRow: number; }

async function seed(collectorBase: string): Promise<SeedIds> {
  const stamp = `${TAG}-${Date.now()}`;
  const [firm] = await db
    .insert(firmsTable)
    .values({ name: `${stamp}-firm`, slug: stamp })
    .returning();
  const [user] = await db
    .insert(usersTable)
    .values({
      email: `${stamp}@example.com`,
      password_hash: "x",
      name: `${TAG} user`,
      role: "admin",
      firm_id: firm.id,
    })
    .returning();

  const mk = async (name: string, subs: string[] | null) => {
    const [row] = await db
      .insert(integrationsTable)
      .values({
        name,
        type: "automation",
        provider: "n8n",
        webhook_url: `${collectorBase}/${name}`,
        status: "active",
        config: subs === null ? null : { userConfig: { subscribed_events: subs } },
      })
      .returning();
    return row.id;
  };
  return {
    firmId: firm.id,
    userId: user.id,
    leadCreatedOnly: await mk(`${TAG}-lc`, ["lead.created"]),
    ocrOnly: await mk(`${TAG}-ocr`, ["ocr.completed"]),
    defaultRow: await mk(`${TAG}-default`, null),
  };
}

async function cleanup(ids: SeedIds): Promise<void> {
  for (const id of [ids.leadCreatedOnly, ids.ocrOnly, ids.defaultRow]) {
    await db.delete(integrationsTable).where(eq(integrationsTable.id, id));
  }
  await db.delete(usersTable).where(eq(usersTable.id, ids.userId));
  await db.delete(firmsTable).where(eq(firmsTable.id, ids.firmId));
}

let collector: Awaited<ReturnType<typeof startCollector>>;
let ids: SeedIds;

before(async () => {
  collector = await startCollector();
  ids = await seed(collector.url);
});

after(async () => {
  await cleanup(ids);
  await collector.close();
});

async function waitForHits(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
}

test("lead.created fans out only to subscribers (incl. default)", async () => {
  collector.hits.length = 0;
  dispatchEvent({ event: "lead.created", payload: { lead: { id: 1, name: "T" } } }, { source: "unit-test" });
  await waitForHits(() => collector.hits.filter((h) => h.url.includes(TAG)).length >= 2);

  const ours = collector.hits.filter((h) => h.url.includes(TAG));
  const urls = ours.map((h) => h.url);
  // legacy/default integration row + explicit lead.created subscriber
  assert.ok(urls.some((u) => u.endsWith(`/${TAG}-lc`)), "lead.created subscriber should fire");
  assert.ok(urls.some((u) => u.endsWith(`/${TAG}-default`)), "default-subscription row should fire");
  assert.ok(!urls.some((u) => u.endsWith(`/${TAG}-ocr`)), "ocr-only subscriber must NOT fire on lead.created");

  for (const h of ours) {
    assert.equal(h.headers["x-mtos-event"], "lead.created");
    assert.ok(typeof h.headers["x-mtos-delivery"] === "string" && (h.headers["x-mtos-delivery"] as string).length > 0);
    const body = JSON.parse(h.body);
    assert.equal(body.event, "lead.created");
    assert.equal(body.source, "unit-test");
  }
});

test("ocr.completed fans out only to ocr subscribers", async () => {
  collector.hits.length = 0;
  dispatchEvent(
    { event: "ocr.completed", payload: { fax_result_id: 99, lead_id: null, drug_name: null, rx_number: null, fill_date: null, quantity: null, confidence: 0.42, success: true } },
    { source: "unit-test" },
  );
  await waitForHits(() => collector.hits.some((h) => h.url.endsWith(`/${TAG}-ocr`)));

  const ours = collector.hits.filter((h) => h.url.includes(TAG));
  const urls = ours.map((h) => h.url);
  assert.ok(urls.some((u) => u.endsWith(`/${TAG}-ocr`)), "ocr subscriber should fire");
  assert.ok(!urls.some((u) => u.endsWith(`/${TAG}-lc`)), "lead.created-only subscriber must not fire");
  assert.ok(!urls.some((u) => u.endsWith(`/${TAG}-default`)), "default (lead.created) subscriber must not fire on ocr");
});
