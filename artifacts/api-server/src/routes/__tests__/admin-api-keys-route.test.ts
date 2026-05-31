/**
 * Route tests for /api/admin/api-keys (Task #83).
 *
 * The IDOR fix (firm-scoped revoke + audit-read) was previously only covered by
 * manual reasoning.  This file locks in four threat scenarios so a regression
 * in the route or the `lib/api-keys.ts` helpers fails CI immediately:
 *
 *   (a) Firm A admin cannot DELETE Firm B's key — 404, not 403, so we don't
 *       leak whether a numeric id exists in another firm.
 *   (b) Firm A admin cannot read audit for Firm B's key — same 404 contract.
 *   (c) Firm A admin can DELETE their own firm's key — 204 + revoked_at stamped.
 *   (d) Firm A admin can read audit for their own firm's key — 200 + entries[].
 *   (e) mtos_ token with `leads:read` is rejected on GET /api/cases (scope
 *       mismatch → 403, not 401).
 *   (f) mtos_ token usage (even the 403 above) writes a row to api_key_audit —
 *       proves the fire-and-forget audit path commits before the response.
 *
 * Like the other route tests here, we boot the real Express app on an ephemeral
 * port so authMiddleware + requirePermission + checkScope all run end-to-end.
 */

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import type { Express } from "express";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { createUser, generateToken } from "../../lib/rbac.js";
import { createApiKey } from "../../lib/api-keys.js";

// Audit log writes for JWT-based actions (role changes, etc.) are off — they
// are not what this suite pins. The api_key_audit writes we DO assert on in
// test (f) are driven by the api-keys lib directly and are unaffected by this flag.
process.env["RBAC_DISABLE_AUDIT"] = "1";
// Subscription gate off — the ephemeral firms have subscription_status=inactive
// by default, which would otherwise block every data route with 402.
process.env["MTOS_DISABLE_BILLING_GATE"] = "1";

function closeAllConnections(server: import("node:http").Server): void {
  const fn = (server as unknown as { closeAllConnections?: () => void }).closeAllConnections;
  if (typeof fn === "function") fn.call(server);
}

let baseUrl = "";
let close: () => Promise<void> = async () => {};

const TS = Date.now();
const FIRM_A_ADMIN_EMAIL = `apikeys-firmA-admin-${TS}@mtos.test`;
const FIRM_B_ADMIN_EMAIL = `apikeys-firmB-admin-${TS}@mtos.test`;
const FIRM_B_SLUG = `apikeys-firm-b-${TS}`;

// Pre-computed hash — we issue JWTs directly so no real password verify happens.
const PASSWORD_HASH = "$2b$10$abcdefghijklmnopqrstuvWxYz0123456789ABCDEFGHIJKLMnopqrs";

let firmAAdminId = 0;
let firmBAdminId = 0;
let firmBId = 0;

// Keys created during setup.
let firmAKeyId = 0;       // belongs to firm 1, used for DELETE + audit tests
let firmBKeyId = 0;       // belongs to Firm B, used for cross-tenant tests
let scopeKeyId = 0;       // belongs to firm 1, scopes=["leads:read"], used for (e)+(f)
let scopeKeyPlaintext = "";

let firmAAdminToken = "";

before(async () => {
  // Create Firm B so we have a true cross-tenant pair.
  const firmBRes = await db.execute(
    sql`INSERT INTO firms (name, slug, billing_email)
        VALUES ('API Keys Firm B', ${FIRM_B_SLUG}, ${`firmb-${TS}@mtos.test`})
        RETURNING id`,
  );
  firmBId = (
    (firmBRes as unknown as { rows?: Array<{ id: number }> }).rows ?? []
  )[0]!.id;

  const firmAAdmin = await createUser(FIRM_A_ADMIN_EMAIL, "Firm A Admin", "admin", PASSWORD_HASH, 1);
  const firmBAdmin = await createUser(FIRM_B_ADMIN_EMAIL, "Firm B Admin", "admin", PASSWORD_HASH, firmBId);
  firmAAdminId = firmAAdmin.id;
  firmBAdminId = firmBAdmin.id;

  // Firm A key — used for own-firm DELETE (c) and own-firm audit read (d).
  const keyA = await createApiKey({
    name: `firm-a-key-${TS}`,
    scopes: ["leads:read"],
    firm_id: 1,
    created_by_user_id: firmAAdminId,
  });
  firmAKeyId = keyA.id;

  // Firm B key — used for cross-tenant rejection (a) + (b).
  const keyB = await createApiKey({
    name: `firm-b-key-${TS}`,
    scopes: ["leads:read"],
    firm_id: firmBId,
    created_by_user_id: firmBAdminId,
  });
  firmBKeyId = keyB.id;

  // Scope-test key — belongs to Firm A admin, only `leads:read` scope.
  // Used in (e) to hit /api/cases (mismatch) and in (f) to verify audit write.
  const scopeKey = await createApiKey({
    name: `scope-test-key-${TS}`,
    scopes: ["leads:read"],
    firm_id: 1,
    created_by_user_id: firmAAdminId,
  });
  scopeKeyId = scopeKey.id;
  scopeKeyPlaintext = scopeKey.plaintext;

  firmAAdminToken = generateToken({
    id: firmAAdmin.id,
    email: firmAAdmin.email,
    name: firmAAdmin.name,
    role: "admin",
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
});

after(async () => {
  // api_key_audit has ON DELETE CASCADE from api_keys so it is cleaned up
  // automatically. Delete api_keys first (FK to users + firms), then users,
  // then firms. Match on the run-unique names rather than `id = ANY(array)` —
  // the array binding silently no-op'd (errors swallowed by .catch), which let
  // every run leak its three keys (and, via the resulting FK errors, its firm +
  // users) into the shared dev DB until 500+ rows piled up.
  //
  // Teardown deletes deliberately do NOT swallow errors anymore: a cleanup
  // failure must surface so CI catches the leak immediately instead of silently
  // accumulating test garbage. We still guarantee the server is closed via the
  // finally block so a teardown throw can't leak the listening socket.
  try {
    await db.execute(
      sql`DELETE FROM api_keys WHERE name IN (${`firm-a-key-${TS}`}, ${`firm-b-key-${TS}`}, ${`scope-test-key-${TS}`})`,
    );
    await db.execute(
      sql`DELETE FROM mtos_users WHERE email IN (${FIRM_A_ADMIN_EMAIL}, ${FIRM_B_ADMIN_EMAIL})`,
    );
    if (firmBId > 0) {
      await db.execute(sql`DELETE FROM firms WHERE id = ${firmBId}`);
    }
    // Prove the cleanup actually removed our rows — a silent no-op here is the
    // exact failure mode that caused the original leak.
    const leftover = await db.execute(
      sql`SELECT COUNT(*)::int AS n FROM api_keys
          WHERE name IN (${`firm-a-key-${TS}`}, ${`firm-b-key-${TS}`}, ${`scope-test-key-${TS}`})`,
    );
    const n = ((leftover as unknown as { rows?: Array<{ n: number }> }).rows ?? [])[0]?.n ?? 0;
    assert.equal(n, 0, `teardown left ${n} api_keys behind — fix cleanup before it leaks`);
  } finally {
    await close();
  }
});

// ---------------------------------------------------------------------------
// Cross-tenant IDOR guard
// ---------------------------------------------------------------------------

test("(a) Firm A admin cannot DELETE Firm B's key — returns 404, not 403 (no existence oracle)", async () => {
  const res = await fetch(`${baseUrl}/api/admin/api-keys/${firmBKeyId}`, {
    method: "DELETE",
    headers: { authorization: `Bearer ${firmAAdminToken}` },
  });
  assert.equal(
    res.status,
    404,
    `cross-tenant DELETE must return 404 (got ${res.status}) — a 403 would confirm the id exists in another firm`,
  );

  // The Firm B key must not have been touched.
  const rows = await db.execute(
    sql`SELECT revoked_at FROM api_keys WHERE id = ${firmBKeyId}`,
  );
  const r = (rows as unknown as { rows?: Array<{ revoked_at: unknown }> }).rows ?? [];
  assert.equal(
    r[0]?.revoked_at,
    null,
    "cross-tenant DELETE must not revoke the target key — IDOR guard must block all mutations",
  );
});

test("(b) Firm A admin cannot read audit for Firm B's key — returns 404 (no cross-tenant leak)", async () => {
  const res = await fetch(`${baseUrl}/api/admin/api-keys/${firmBKeyId}/audit`, {
    headers: { authorization: `Bearer ${firmAAdminToken}` },
  });
  assert.equal(
    res.status,
    404,
    `cross-tenant audit read must return 404 (got ${res.status}) — a 200 or 403 would expose information about the key`,
  );
});

// ---------------------------------------------------------------------------
// Same-firm happy paths
// ---------------------------------------------------------------------------

test("(c) Firm A admin can DELETE their own firm's key — 204 and revoked_at is stamped in DB", async () => {
  const res = await fetch(`${baseUrl}/api/admin/api-keys/${firmAKeyId}`, {
    method: "DELETE",
    headers: { authorization: `Bearer ${firmAAdminToken}` },
  });
  assert.equal(res.status, 204, `same-firm DELETE must return 204, got ${res.status}`);

  // Confirm the DB row now has revoked_at set.
  const rows = await db.execute(
    sql`SELECT revoked_at FROM api_keys WHERE id = ${firmAKeyId}`,
  );
  const r = (rows as unknown as { rows?: Array<{ revoked_at: unknown }> }).rows ?? [];
  assert.ok(
    r[0]?.revoked_at !== null && r[0]?.revoked_at !== undefined,
    "revoked_at must be stamped on a successful DELETE — the middleware relies on this to reject the key on subsequent auth",
  );
});

test("(d) Firm A admin can read audit for their own firm's key — 200 with entries array", async () => {
  // Use the scope-test key (belongs to Firm A, not yet deleted by test (c)).
  const res = await fetch(`${baseUrl}/api/admin/api-keys/${scopeKeyId}/audit`, {
    headers: { authorization: `Bearer ${firmAAdminToken}` },
  });
  assert.equal(res.status, 200, `same-firm audit read must return 200, got ${res.status}`);
  const body = (await res.json()) as { entries?: unknown };
  assert.ok(
    Array.isArray(body.entries),
    "response must include an 'entries' array (may be empty if the key has not been used yet)",
  );
});

// ---------------------------------------------------------------------------
// mtos_ token scope enforcement + audit write
// ---------------------------------------------------------------------------

test("(e) mtos_ token with 'leads:read' is rejected on GET /api/cases — scope mismatch → 403", async () => {
  // The key has `leads:read` scope. The path `/api/cases` resolves to segment
  // `cases`, which requires `cases:read` or `cases:write` — neither present.
  // authMiddleware must return 403 (not 401) because the key was authenticated
  // successfully; the denial is a scope policy decision, not an identity failure.
  const res = await fetch(`${baseUrl}/api/cases`, {
    method: "GET",
    headers: { authorization: `Bearer ${scopeKeyPlaintext}` },
  });
  assert.equal(
    res.status,
    403,
    `scope mismatch must return 403 (got ${res.status}) — scope check should deny access to /api/cases for a leads:read key`,
  );
  // authMiddleware uses errorEnvelope → { status: "error", code, message }
  const body = (await res.json()) as { status?: string; code?: string; message?: string };
  assert.equal(body.status, "error", "403 response must use the standard error envelope");
  assert.equal(typeof body.message, "string", "403 response must include a message string");
  assert.match(
    String(body.message),
    /scope/i,
    "403 message must mention 'scope' so the API consumer knows the key lacks the right permission",
  );
});

test("(f) mtos_ token usage (scope-denied request) writes a row to api_key_audit", async () => {
  // The scope-denied 403 from test (e) triggers auditApiKeyRequest synchronously
  // before the response is sent (see authMiddleware lines that call it in the
  // scope-denial branch). The insert is fire-and-forget so we give it a short
  // grace period to commit.
  await new Promise<void>((resolve) => setTimeout(resolve, 150));

  const rows = await db.execute(
    sql`SELECT api_key_id, method, route, status_code
        FROM api_key_audit
        WHERE api_key_id = ${scopeKeyId}
        ORDER BY occurred_at DESC
        LIMIT 5`,
  );
  const entries = (
    rows as unknown as {
      rows?: Array<{
        api_key_id: number;
        method: string;
        route: string;
        status_code: number;
      }>;
    }
  ).rows ?? [];

  assert.ok(
    entries.length > 0,
    "api_key_audit must contain at least one row for the scope-denied request — proves the audit pipeline commits",
  );

  const scopeDeniedRow = entries.find((r) => r.status_code === 403);
  assert.ok(
    scopeDeniedRow,
    "api_key_audit must include a row with status_code=403 from the scope-denied GET /api/cases request",
  );
  assert.equal(
    scopeDeniedRow.api_key_id,
    scopeKeyId,
    "audit row must be bound to the exact key that made the request — not another key in the same firm",
  );
  assert.equal(
    scopeDeniedRow.method,
    "GET",
    "audit row must record the HTTP method of the denied request",
  );
  assert.ok(
    String(scopeDeniedRow.route).includes("cases"),
    `audit row must record the target route — expected '/api/cases...' but got '${scopeDeniedRow.route}'`,
  );
});
