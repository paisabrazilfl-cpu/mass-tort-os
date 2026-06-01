// Focused ownership coverage for the per-user Favorites router (Task #149):
//   GET    /api/favorites      -> list ONLY the caller's favorites
//   PATCH  /api/favorites/:id  -> edit, scoped to user_id = caller
//   DELETE /api/favorites/:id  -> remove, scoped to user_id = caller
//
// What this file locks in (the foot-gun the route must never regress on):
// Favorites are per-user bookmarks. Ownership is enforced in the route by
// scoping every read/update/delete to the caller's user_id. If a future
// change drops that `user_id = req.user.id` filter, one logged-in user
// could read, edit, or delete another user's favorites. These tests pin
// that boundary:
//   (a) user B's GET list never contains user A's row, even same-firm.
//   (b) user B PATCH against A's id returns 404 (not 403) AND does not
//       mutate A's row — 404 so we don't even confirm the id exists.
//   (c) user B DELETE against A's id returns 404 AND A's row survives.
//   (d) positive control: A can PATCH and DELETE their own row, proving
//       the 404s above are an ownership boundary, not a broken route.
//
// Both users live in the SAME firm (firm_id=1) on purpose: the guarantee
// is user-level, independent of firm tenancy. Like the other route tests
// here, we boot the real Express app on an ephemeral port so
// authMiddleware runs end-to-end.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import type { Express } from "express";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { createUser, generateToken } from "../../lib/rbac.js";

// Favorites routes have no permission gate or billing gate (any
// authenticated user manages their own list), but we keep audit writes
// off — this suite asserts the ownership boundary, not audit shape — and
// disable the billing gate defensively in case a global gate is mounted.
process.env["RBAC_DISABLE_AUDIT"] = "1";
process.env["MTOS_DISABLE_BILLING_GATE"] = "1";

// Pre-computed bcrypt hash for a throwaway password. The tests issue JWTs
// directly via generateToken and never verify credentials, so the hash
// value is irrelevant — it only has to satisfy the NOT NULL column.
const PASSWORD_HASH = "$2b$10$abcdefghijklmnopqrstuvWxYz0123456789ABCDEFGHIJKLMnopqrs";

function closeAllConnections(server: import("node:http").Server): void {
  const fn = (server as unknown as { closeAllConnections?: () => void }).closeAllConnections;
  if (typeof fn === "function") fn.call(server);
}

let baseUrl = "";
let close: () => Promise<void> = async () => {};

const TS = Date.now();
const USER_A_EMAIL = `fav-a-${TS}@mtos.test`;
const USER_B_EMAIL = `fav-b-${TS}@mtos.test`;

let userAId = 0;
let userBId = 0;
let tokenA = "";
let tokenB = "";

// The favorite row owned by user A that user B must never be able to
// touch. Created via the real POST route in before().
let favAId = 0;

before(async () => {
  const userA = await createUser(USER_A_EMAIL, "Fav User A", "viewer", PASSWORD_HASH, 1);
  const userB = await createUser(USER_B_EMAIL, "Fav User B", "viewer", PASSWORD_HASH, 1);
  userAId = userA.id;
  userBId = userB.id;

  tokenA = generateToken({
    id: userA.id,
    email: userA.email,
    name: userA.name,
    role: "viewer",
    firm_id: 1,
  });
  tokenB = generateToken({
    id: userB.id,
    email: userB.email,
    name: userB.name,
    role: "viewer",
    firm_id: 1,
  });

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

  // Seed a favorite owned by user A through the real route.
  const createRes = await fetch(`${baseUrl}/api/favorites`, {
    method: "POST",
    headers: { authorization: `Bearer ${tokenA}`, "Content-Type": "application/json" },
    body: JSON.stringify({ url: "https://owned-by-a.example.com", label: "A only" }),
  });
  assert.equal(createRes.status, 201, "seed: user A must be able to create their own favorite");
  const created = (await createRes.json()) as { id: number; user_id: number };
  favAId = created.id;
  assert.equal(created.user_id, userAId, "seed: favorite must belong to user A");
});

after(async () => {
  await db
    .execute(sql`DELETE FROM favorites WHERE user_id IN (${userAId}, ${userBId})`)
    .catch(() => {});
  await db
    .execute(sql`DELETE FROM mtos_users WHERE email IN (${USER_A_EMAIL}, ${USER_B_EMAIL})`)
    .catch(() => {});
  await close();
});

test("(a) GET /api/favorites as user B never returns user A's row", async () => {
  const res = await fetch(`${baseUrl}/api/favorites`, {
    headers: { authorization: `Bearer ${tokenB}` },
  });
  assert.equal(res.status, 200);
  const rows = (await res.json()) as Array<{ id: number; user_id: number }>;
  assert.ok(
    !rows.some((r) => r.id === favAId),
    "user B's list must NOT include user A's favorite — that would be a cross-user leak",
  );
  for (const r of rows) {
    assert.equal(
      r.user_id,
      userBId,
      `every row in B's list must be scoped to B, got user_id=${r.user_id}`,
    );
  }
});

test("(b) PATCH /api/favorites/:id against another user's row returns 404 and does not mutate it", async () => {
  const res = await fetch(`${baseUrl}/api/favorites/${favAId}`, {
    method: "PATCH",
    headers: { authorization: `Bearer ${tokenB}`, "Content-Type": "application/json" },
    body: JSON.stringify({ label: "hijacked by B" }),
  });
  assert.equal(
    res.status,
    404,
    "user B editing A's favorite must read as 'not found' — a 403 would confirm the id exists",
  );

  const rows = await db.execute(
    sql`SELECT label, user_id FROM favorites WHERE id = ${favAId}`,
  );
  const r = (rows as unknown as { rows?: Array<{ label: string; user_id: number }> }).rows ?? [];
  assert.equal(r[0]?.user_id, userAId, "row must still belong to user A");
  assert.equal(r[0]?.label, "A only", "cross-user PATCH must NOT mutate the label");
});

test("(c) DELETE /api/favorites/:id against another user's row returns 404 and the row survives", async () => {
  const res = await fetch(`${baseUrl}/api/favorites/${favAId}`, {
    method: "DELETE",
    headers: { authorization: `Bearer ${tokenB}` },
  });
  assert.equal(
    res.status,
    404,
    "user B deleting A's favorite must read as 'not found', never succeed",
  );

  const rows = await db.execute(sql`SELECT id FROM favorites WHERE id = ${favAId}`);
  const r = (rows as unknown as { rows?: Array<{ id: number }> }).rows ?? [];
  assert.equal(r.length, 1, "user A's favorite must still exist after B's delete attempt");
});

test("(e) de-dup: POST the same URL twice creates ONE row (label upserts, not duplicated)", async () => {
  const dupUrl = "https://dup-test.example.com/page";
  // First add — creates the row.
  const first = await fetch(`${baseUrl}/api/favorites`, {
    method: "POST",
    headers: { authorization: `Bearer ${tokenA}`, "Content-Type": "application/json" },
    body: JSON.stringify({ url: dupUrl, label: "first label" }),
  });
  assert.equal(first.status, 201);
  const firstRow = (await first.json()) as { id: number; label: string };

  // Second add of the SAME url — must NOT create a second row; updates label.
  const second = await fetch(`${baseUrl}/api/favorites`, {
    method: "POST",
    headers: { authorization: `Bearer ${tokenA}`, "Content-Type": "application/json" },
    body: JSON.stringify({ url: dupUrl, label: "second label" }),
  });
  assert.equal(second.status, 201);
  const secondRow = (await second.json()) as { id: number; label: string };
  assert.equal(secondRow.id, firstRow.id, "re-adding a URL must reuse the same row, not insert a new one");
  assert.equal(secondRow.label, "second label", "re-adding with a label must update the existing label");

  // Exactly one row exists for (user A, dupUrl).
  const rows = await db.execute(
    sql`SELECT id FROM favorites WHERE user_id = ${userAId} AND url = ${dupUrl}`,
  );
  const r = (rows as unknown as { rows?: Array<{ id: number }> }).rows ?? [];
  assert.equal(r.length, 1, "adding the same URL twice must leave exactly one favorites row");

  // Cleanup this test's row so it doesn't leak into the shared dev DB.
  await db.execute(sql`DELETE FROM favorites WHERE user_id = ${userAId} AND url = ${dupUrl}`);
});

test("(f) bulk: already-saved URLs are skipped as duplicates, not re-inserted", async () => {
  const keep = "https://bulk-existing.example.com/page";
  // Seed one URL via single POST.
  const seed = await fetch(`${baseUrl}/api/favorites`, {
    method: "POST",
    headers: { authorization: `Bearer ${tokenA}`, "Content-Type": "application/json" },
    body: JSON.stringify({ url: keep }),
  });
  assert.equal(seed.status, 201);

  // Bulk import that includes the already-saved URL plus one new one.
  const fresh = "https://bulk-fresh.example.com/page";
  const bulk = await fetch(`${baseUrl}/api/favorites/bulk`, {
    method: "POST",
    headers: { authorization: `Bearer ${tokenA}`, "Content-Type": "application/json" },
    body: JSON.stringify({ urls: `${keep}\n${fresh}` }),
  });
  assert.equal(bulk.status, 201);
  const body = (await bulk.json()) as {
    addedCount: number;
    duplicates: string[];
    skipped: string[];
  };
  assert.equal(body.addedCount, 1, "only the new URL should be added");
  assert.ok(
    body.duplicates.includes(keep),
    "the already-saved URL must be reported in duplicates",
  );

  // Still exactly one row for the pre-existing URL.
  const rows = await db.execute(
    sql`SELECT id FROM favorites WHERE user_id = ${userAId} AND url = ${keep}`,
  );
  const r = (rows as unknown as { rows?: Array<{ id: number }> }).rows ?? [];
  assert.equal(r.length, 1, "bulk import must not duplicate an already-saved URL");

  await db.execute(
    sql`DELETE FROM favorites WHERE user_id = ${userAId} AND url IN (${keep}, ${fresh})`,
  );
});

test("(d) positive control: user A can PATCH then DELETE their own favorite", async () => {
  const patchRes = await fetch(`${baseUrl}/api/favorites/${favAId}`, {
    method: "PATCH",
    headers: { authorization: `Bearer ${tokenA}`, "Content-Type": "application/json" },
    body: JSON.stringify({ label: "renamed by A" }),
  });
  assert.equal(patchRes.status, 200, "owner must be able to edit their own favorite");
  const patched = (await patchRes.json()) as { label: string; id: number };
  assert.equal(patched.label, "renamed by A", "owner edit must apply");

  const delRes = await fetch(`${baseUrl}/api/favorites/${favAId}`, {
    method: "DELETE",
    headers: { authorization: `Bearer ${tokenA}` },
  });
  assert.equal(delRes.status, 200, "owner must be able to delete their own favorite");

  const rows = await db.execute(sql`SELECT id FROM favorites WHERE id = ${favAId}`);
  const r = (rows as unknown as { rows?: Array<{ id: number }> }).rows ?? [];
  assert.equal(r.length, 0, "owner delete must remove the row");
});
