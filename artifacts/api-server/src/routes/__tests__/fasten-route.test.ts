// Cross-firm IDOR coverage for the Fasten Health operator routes.
//
// What this file pins (each maps to a real foot-gun the architect
// flagged in the original Fasten review — that finding was caught by
// inspection, this suite would catch a regression):
//
//   (a) POST /api/fasten/connect with lead_id pointing at another
//       firm's lead returns 404 — the body must read "Lead not
//       found", never "wrong firm" (no enumeration oracle), and no
//       fasten_connections row may be inserted on firm B's behalf.
//   (b) GET /api/fasten/connections/:leadId for another firm's lead
//       returns an empty list — even when the caller knows the row's
//       primary key, the route MUST scope by caller's firm_id.
//   (c) POST /api/fasten/sync/:connectionId against another firm's
//       connection returns 404 (not 403, not 409) and does NOT
//       enqueue a job. Confirmed by polling job_queue afterwards.
//   (d) POST /api/fasten/disconnect/:connectionId against another
//       firm's connection returns 404 AND leaves the row's status
//       UNCHANGED (no silent mutation across the firm boundary).
//   (e) GET /api/fasten/callback?state=<firm B's saved state> from
//       firm A returns 404. The callback handler intentionally
//       rescopes its lookup by callerFirmId so a stolen state value
//       cannot be claimed by another tenant.
//
// We boot the real Express app on an ephemeral port (mirroring the
// pattern in users-route.test.ts) so authMiddleware + firmContext +
// requirePermission(MEDICAL_RECORDS_*) all run end-to-end.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import type { Express } from "express";
import {
  db,
  fastenConnectionsTable,
  jobQueueTable,
  leadsTable,
} from "@workspace/db";
import { eq, sql } from "drizzle-orm";
import { createUser, generateToken } from "../../lib/rbac.js";

// Audit writes are noisy and not what this suite pins.
process.env["RBAC_DISABLE_AUDIT"] = "1";
// The cross-firm seed firm has subscription_status='inactive' by default —
// the billing gate would otherwise return 402 before any route handler runs
// and we'd never reach the cross-firm scoping code we're trying to test.
process.env["MTOS_DISABLE_BILLING_GATE"] = "1";

const PASSWORD_HASH = "$2b$10$abcdefghijklmnopqrstuvWxYz0123456789ABCDEFGHIJKLMnopqrs";

function closeAllConnections(server: import("node:http").Server): void {
  const fn = (server as unknown as { closeAllConnections?: () => void }).closeAllConnections;
  if (typeof fn === "function") fn.call(server);
}

let baseUrl = "";
let close: () => Promise<void> = async () => {};

const TS = Date.now();
const FIRM_A_ID = 1;
const FIRM_B_SLUG = `fasten-firm-b-${TS}`;
const A_USER_EMAIL = `fasten-a-${TS}@mtos.test`;
const B_USER_EMAIL = `fasten-b-${TS}@mtos.test`;

let firmBId = 0;
let aUserId = 0;
let bUserId = 0;
let aToken = "";
let bToken = "";

// Seeded data: a lead and a fasten_connections row in EACH firm. The
// cross-firm probes in the tests below all use firm B's ids while
// authenticated as firm A's user.
let firmALeadId = 0;
let firmBLeadId = 0;
let firmAConnId = 0;
let firmBConnId = 0;

const FIRM_B_STATE = `state-firm-b-${TS}`;
const FIRM_A_PORTAL = `epic-${TS}-a`;
const FIRM_B_PORTAL = `epic-${TS}-b`;

before(async () => {
  // Create firm B so we can pin cross-firm isolation. Firm A is the
  // default firm seeded by firm-bootstrap.ts (id=1).
  const firmRes = await db.execute(
    sql`INSERT INTO firms (name, slug, billing_email)
        VALUES ('Fasten Test Firm B', ${FIRM_B_SLUG}, ${`fasten-b-${TS}@mtos.test`})
        RETURNING id`,
  );
  firmBId = ((firmRes as unknown as { rows?: Array<{ id: number }> }).rows ?? [])[0]!.id;

  const aUser = await createUser(A_USER_EMAIL, "Firm A Para", "paralegal", PASSWORD_HASH, FIRM_A_ID);
  const bUser = await createUser(B_USER_EMAIL, "Firm B Para", "paralegal", PASSWORD_HASH, firmBId);
  aUserId = aUser.id;
  bUserId = bUser.id;

  aToken = generateToken({
    id: aUser.id,
    email: aUser.email,
    name: aUser.name,
    role: "paralegal",
    firm_id: FIRM_A_ID,
  });
  bToken = generateToken({
    id: bUser.id,
    email: bUser.email,
    name: bUser.name,
    role: "paralegal",
    firm_id: firmBId,
  });

  // Seed one lead per firm — leads are the cross-firm boundary the
  // /connect, /connections, and /sync routes guard.
  const [aLead] = await db
    .insert(leadsTable)
    .values({
      name: "Firm A Patient",
      tort_type: `fasten-test-${TS}`,
      firm_id: FIRM_A_ID,
    } as typeof leadsTable.$inferInsert)
    .returning({ id: leadsTable.id });
  const [bLead] = await db
    .insert(leadsTable)
    .values({
      name: "Firm B Patient",
      tort_type: `fasten-test-${TS}`,
      firm_id: firmBId,
    } as typeof leadsTable.$inferInsert)
    .returning({ id: leadsTable.id });
  firmALeadId = aLead!.id;
  firmBLeadId = bLead!.id;

  // Seed one fasten_connections row per firm. The firm B row carries
  // the FIRM_B_STATE value so test (e) can probe the callback handler
  // with a state value the firm A token has no business claiming.
  const [aConn] = await db
    .insert(fastenConnectionsTable)
    .values({
      firm_id: FIRM_A_ID,
      lead_id: firmALeadId,
      backend: "connect",
      portal_id: FIRM_A_PORTAL,
      portal_name: "Firm A Epic",
      org_connection_id: "oc_firm_a",
      status: "active",
      metadata: { state: `state-firm-a-${TS}`, external_id: "ext_a" },
    })
    .returning({ id: fastenConnectionsTable.id });
  const [bConn] = await db
    .insert(fastenConnectionsTable)
    .values({
      firm_id: firmBId,
      lead_id: firmBLeadId,
      backend: "connect",
      portal_id: FIRM_B_PORTAL,
      portal_name: "Firm B Epic",
      org_connection_id: "oc_firm_b",
      status: "active",
      metadata: { state: FIRM_B_STATE, external_id: "ext_b" },
    })
    .returning({ id: fastenConnectionsTable.id });
  firmAConnId = aConn!.id;
  firmBConnId = bConn!.id;

  const appMod = (await import("../../app.js")) as { default: Express };
  const app = appMod.default;
  await new Promise<void>((resolve, reject) => {
    const server = app.listen(0, () => {
      const addr = server.address() as AddressInfo | null;
      if (!addr || typeof addr === "string") {
        reject(new Error("could not resolve listen address"));
        return;
      }
      baseUrl = `http://127.0.0.1:${addr.port}`;
      close = () =>
        new Promise<void>((res) => {
          closeAllConnections(server);
          server.close(() => res());
        });
      resolve();
    });
    server.on("error", reject);
  });
});

after(async () => {
  // Tear down in FK-safe order: connections → jobs → leads → users → firm.
  if (firmAConnId || firmBConnId) {
    await db
      .delete(fastenConnectionsTable)
      .where(eq(fastenConnectionsTable.firm_id, firmBId))
      .catch(() => {});
    await db
      .delete(fastenConnectionsTable)
      .where(eq(fastenConnectionsTable.id, firmAConnId))
      .catch(() => {});
  }
  if (firmALeadId || firmBLeadId) {
    await db
      .execute(sql`DELETE FROM leads WHERE id IN (${firmALeadId}, ${firmBLeadId})`)
      .catch(() => {});
  }
  await db
    .execute(sql`DELETE FROM mtos_users WHERE email IN (${A_USER_EMAIL}, ${B_USER_EMAIL})`)
    .catch(() => {});
  if (firmBId) {
    await db.execute(sql`DELETE FROM firms WHERE id = ${firmBId}`).catch(() => {});
  }
  await close();
});

test("(a) POST /api/fasten/connect for another firm's lead returns 404 and inserts no connection row", async () => {
  // Snapshot the count of fasten_connections in firm B BEFORE the cross-
  // firm probe so we can prove no insert leaked through on firm B's behalf.
  const beforeRows = await db
    .select({ id: fastenConnectionsTable.id })
    .from(fastenConnectionsTable)
    .where(eq(fastenConnectionsTable.firm_id, firmBId));
  const beforeCount = beforeRows.length;

  const res = await fetch(`${baseUrl}/api/fasten/connect`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${aToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      lead_id: firmBLeadId,
      backend: "connect",
      brand_id: "epic",
    }),
  });
  assert.equal(
    res.status,
    404,
    `cross-firm /connect must read as 'lead not found', got ${res.status}`,
  );
  const body = (await res.json()) as { error?: string; message?: string };
  // The route uses notFound() which produces { error: "Lead not found" }
  // — pin that wording so we don't accidentally start leaking "wrong
  // firm" or "forbidden" copy that would confirm the lead exists.
  const text = `${body.error ?? ""} ${body.message ?? ""}`.toLowerCase();
  assert.match(
    text,
    /not found/,
    "cross-firm /connect response must say 'not found' (no enumeration oracle for tenant lead ids)",
  );

  const afterRows = await db
    .select({ id: fastenConnectionsTable.id })
    .from(fastenConnectionsTable)
    .where(eq(fastenConnectionsTable.firm_id, firmBId));
  assert.equal(
    afterRows.length,
    beforeCount,
    "cross-firm /connect must NOT insert a fasten_connections row on the victim firm's behalf",
  );
});

test("(b) GET /api/fasten/connections/:leadId for another firm's lead returns an empty list", async () => {
  // Sanity: firm B has at least one connection on this lead — otherwise
  // an empty result would be vacuously true.
  const sanityRows = await db
    .select()
    .from(fastenConnectionsTable)
    .where(eq(fastenConnectionsTable.lead_id, firmBLeadId));
  assert.ok(sanityRows.length > 0, "fixture must seed at least one firm B connection on the probed lead");

  const res = await fetch(`${baseUrl}/api/fasten/connections/${firmBLeadId}`, {
    headers: { authorization: `Bearer ${aToken}` },
  });
  assert.equal(res.status, 200, `expected 200 with empty list, got ${res.status}`);
  const body = (await res.json()) as { connections: Array<{ id: number; firm_id: number }> };
  assert.ok(Array.isArray(body.connections), "response must always carry a connections[] array");
  assert.equal(
    body.connections.length,
    0,
    "firm A must see ZERO rows for firm B's lead — even though the row exists, scoping by callerFirmId must filter it out",
  );

  // And the firm B token CAN see it — proves the empty list above is a
  // scoping decision, not a bug that hides every row from everyone.
  const ownerRes = await fetch(`${baseUrl}/api/fasten/connections/${firmBLeadId}`, {
    headers: { authorization: `Bearer ${bToken}` },
  });
  assert.equal(ownerRes.status, 200);
  const ownerBody = (await ownerRes.json()) as { connections: Array<{ id: number }> };
  assert.ok(
    ownerBody.connections.some((c) => c.id === firmBConnId),
    "the owning firm B user MUST still see their own connection — proves filtering is scoped, not blanket",
  );
});

test("(c) POST /api/fasten/sync/:connectionId for another firm's connection returns 404 and enqueues no job", async () => {
  // Snapshot job_queue size for fasten_records_sync before the probe.
  const beforeJobs = await db
    .select({ id: jobQueueTable.id })
    .from(jobQueueTable)
    .where(eq(jobQueueTable.job_type, "fasten_records_sync"));
  const beforeCount = beforeJobs.length;

  const res = await fetch(`${baseUrl}/api/fasten/sync/${firmBConnId}`, {
    method: "POST",
    headers: { authorization: `Bearer ${aToken}` },
  });
  assert.equal(
    res.status,
    404,
    "cross-firm /sync must read as 'connection not found', not 403/409 (those would confirm the row exists)",
  );

  const afterJobs = await db
    .select({ id: jobQueueTable.id })
    .from(jobQueueTable)
    .where(eq(jobQueueTable.job_type, "fasten_records_sync"));
  assert.equal(
    afterJobs.length,
    beforeCount,
    "cross-firm /sync must NOT enqueue a fasten_records_sync job — that would let firm A trigger a download against firm B's portal",
  );

  // The connection row's status must remain unchanged.
  const [conn] = await db
    .select({ status: fastenConnectionsTable.status })
    .from(fastenConnectionsTable)
    .where(eq(fastenConnectionsTable.id, firmBConnId));
  assert.equal(
    conn?.status,
    "active",
    "cross-firm /sync must NOT flip firm B's connection.status to 'syncing'",
  );
});

test("(d) POST /api/fasten/disconnect/:connectionId for another firm's connection returns 404 and does not mutate the row", async () => {
  const res = await fetch(`${baseUrl}/api/fasten/disconnect/${firmBConnId}`, {
    method: "POST",
    headers: { authorization: `Bearer ${aToken}` },
  });
  assert.equal(
    res.status,
    404,
    "cross-firm /disconnect must read as 'not found' rather than silently revoking firm B's connection",
  );

  const [conn] = await db
    .select({ status: fastenConnectionsTable.status })
    .from(fastenConnectionsTable)
    .where(eq(fastenConnectionsTable.id, firmBConnId));
  assert.equal(
    conn?.status,
    "active",
    "cross-firm /disconnect must NOT flip firm B's connection.status to 'revoked'",
  );

  // And the rightful firm B owner CAN disconnect their own row — proves
  // the 404 above is a scoping decision, not a blanket failure.
  const ownerRes = await fetch(`${baseUrl}/api/fasten/disconnect/${firmBConnId}`, {
    method: "POST",
    headers: { authorization: `Bearer ${bToken}` },
  });
  assert.equal(ownerRes.status, 200, "firm B's own user MUST be able to disconnect their connection");
  const [after] = await db
    .select({ status: fastenConnectionsTable.status })
    .from(fastenConnectionsTable)
    .where(eq(fastenConnectionsTable.id, firmBConnId));
  assert.equal(after?.status, "revoked", "owner-initiated disconnect must mark the row revoked");
});

test("(e) GET /api/fasten/callback?state=<firm B's state> from firm A returns 404 (state cannot be cross-claimed)", async () => {
  const res = await fetch(
    `${baseUrl}/api/fasten/callback?state=${encodeURIComponent(FIRM_B_STATE)}&org_connection_id=hijack_attempt`,
    {
      headers: { authorization: `Bearer ${aToken}` },
      // Don't follow the redirect — we want to see the JSON 404 body if the
      // cross-firm scope check fires (the success path 302s away).
      redirect: "manual",
    },
  );
  assert.equal(
    res.status,
    404,
    "cross-firm /callback must NOT redirect away with a 302 — that would mean firm A successfully claimed firm B's state value",
  );

  // The firm B connection row's org_connection_id must NOT have been
  // overwritten with the value firm A supplied — the callback handler
  // updates org_connection_id on success, and "hijack_attempt" landing
  // here would mean the cross-firm scope check failed.
  const [conn] = await db
    .select({ org_connection_id: fastenConnectionsTable.org_connection_id })
    .from(fastenConnectionsTable)
    .where(eq(fastenConnectionsTable.id, firmBConnId));
  assert.equal(
    conn?.org_connection_id,
    "oc_firm_b",
    "cross-firm /callback must NOT overwrite firm B's org_connection_id with the attacker-supplied value",
  );
});
