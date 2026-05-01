// Focused coverage for the admin Users page endpoints (Task #58):
//   GET   /api/users              -> list firm members (USERS_LIST)
//   PATCH /api/users/:id/role     -> elevate / demote (USERS_MANAGE)
//
// What this file pins (each maps to a real foot-gun the route must
// not regress on):
//   (a) GET as admin returns ONLY users in the caller's firm. A row
//       seeded into a different firm must never appear, even when the
//       caller knows the id.
//   (b) GET as a viewer is rejected by USERS_LIST → 403.
//   (c) PATCH happy path elevates viewer→paralegal AND bumps
//       token_version atomically so the user's old JWTs are revoked.
//   (d) PATCH against the caller's own row returns 403
//       cannot_change_own_role even when the caller is admin (so a
//       single admin can't accidentally demote themselves into
//       lockout).
//   (e) PATCH against a user_id in a different firm returns 404 — the
//       route must NOT leak existence across the firm boundary.
//
// Like the other route tests in this directory, we boot the real
// Express app on an ephemeral port so authMiddleware + firmContext +
// requirePermission all run end-to-end.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import type { Express } from "express";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { createUser, generateToken } from "../../lib/rbac.js";

process.env["RBAC_DISABLE_AUDIT"] = "1";
// Subscription/billing gate off — this suite asserts the role-management
// permission and self-edit guards, not billing posture. The gate has its
// own coverage in subscription-gate.test.ts. Without this, every PATCH
// here trips the 402 NO_FIRM branch because the ephemeral firms have
// subscription_status='inactive' by default (see firm-bootstrap.ts).
process.env["MTOS_DISABLE_BILLING_GATE"] = "1";

// Pre-computed bcrypt hash for "Sup3r$ecret!Pa$$w0rd" — we never call
// verify on these accounts (the tests issue JWTs directly via
// generateToken), so we don't need a real hash function in the test file.
// Hardcoding keeps the route tests free of any auth-stack dependency
// that might drift later.
const PASSWORD_HASH = "$2b$10$abcdefghijklmnopqrstuvWxYz0123456789ABCDEFGHIJKLMnopqrs";

function closeAllConnections(server: import("node:http").Server): void {
  const fn = (server as unknown as { closeAllConnections?: () => void }).closeAllConnections;
  if (typeof fn === "function") fn.call(server);
}

let baseUrl = "";
let close: () => Promise<void> = async () => {};

const TS = Date.now();
const ADMIN_EMAIL = `users-admin-${TS}@mtos.test`;
const VIEWER_EMAIL = `users-viewer-${TS}@mtos.test`;
const TARGET_EMAIL = `users-target-${TS}@mtos.test`;
const OTHER_FIRM_EMAIL = `users-otherfirm-${TS}@mtos.test`;
const OTHER_FIRM_SLUG = `users-other-firm-${TS}`;

let adminId = 0;
let viewerId = 0;
let targetId = 0;
let otherFirmId = 0;
let otherFirmUserId = 0;
let adminToken = "";
let viewerToken = "";

before(async () => {
  // Spin up a second firm so we can pin cross-firm isolation. Use a
  // unique slug per test run so re-runs against a non-pristine DB do
  // not collide.
  const firmRes = await db.execute(
    sql`INSERT INTO firms (name, slug, billing_email)
        VALUES ('Other Firm', ${OTHER_FIRM_SLUG}, ${`other-${TS}@mtos.test`})
        RETURNING id`,
  );
  otherFirmId = (
    (firmRes as unknown as { rows?: Array<{ id: number }> }).rows ?? []
  )[0]!.id;

  const admin = await createUser(ADMIN_EMAIL, "Admin", "admin", PASSWORD_HASH, 1);
  const viewer = await createUser(VIEWER_EMAIL, "Viewer", "viewer", PASSWORD_HASH, 1);
  const target = await createUser(TARGET_EMAIL, "Target", "viewer", PASSWORD_HASH, 1);
  const otherUser = await createUser(
    OTHER_FIRM_EMAIL,
    "Other Firm User",
    "viewer",
    PASSWORD_HASH,
    otherFirmId,
  );
  adminId = admin.id;
  viewerId = viewer.id;
  targetId = target.id;
  otherFirmUserId = otherUser.id;

  adminToken = generateToken({
    id: admin.id,
    email: admin.email,
    name: admin.name,
    role: "admin",
    firm_id: 1,
  });
  viewerToken = generateToken({
    id: viewer.id,
    email: viewer.email,
    name: viewer.name,
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
});

after(async () => {
  await db
    .execute(
      sql`DELETE FROM mtos_users WHERE email IN (${ADMIN_EMAIL}, ${VIEWER_EMAIL}, ${TARGET_EMAIL}, ${OTHER_FIRM_EMAIL})`,
    )
    .catch(() => {});
  if (otherFirmId > 0) {
    await db.execute(sql`DELETE FROM firms WHERE id = ${otherFirmId}`).catch(() => {});
  }
  await close();
});

test("(a) GET /api/users as admin returns only users in the caller's firm", async () => {
  const res = await fetch(`${baseUrl}/api/users`, {
    headers: { authorization: `Bearer ${adminToken}` },
  });
  assert.equal(res.status, 200);
  const body = (await res.json()) as {
    status: string;
    data: { rows: Array<{ id: number; firm_id: number; email: string }> };
  };
  assert.equal(body.status, "ok");
  const ids = body.data.rows.map((r) => r.id);
  assert.ok(ids.includes(adminId), "admin must see themselves");
  assert.ok(ids.includes(viewerId), "admin must see firm viewer");
  assert.ok(ids.includes(targetId), "admin must see firm target");
  assert.ok(
    !ids.includes(otherFirmUserId),
    "users in another firm must NOT appear in the result — that would be a privilege escalation",
  );
  for (const row of body.data.rows) {
    assert.equal(
      row.firm_id,
      1,
      `every returned row must be scoped to firm_id=1, got firm_id=${row.firm_id}`,
    );
  }
});

test("(b) GET /api/users as a viewer is rejected by USERS_LIST → 403", async () => {
  const res = await fetch(`${baseUrl}/api/users`, {
    headers: { authorization: `Bearer ${viewerToken}` },
  });
  assert.equal(res.status, 403, "viewer must not be allowed to list firm users");
});

test("(c) PATCH /api/users/:id/role elevates viewer→paralegal AND bumps token_version", async () => {
  const beforeRows = await db.execute(
    sql`SELECT token_version FROM mtos_users WHERE id = ${targetId}`,
  );
  const before =
    (beforeRows as unknown as { rows?: Array<{ token_version: number }> }).rows ?? [];
  const tvBefore = before[0]?.token_version ?? 0;

  const res = await fetch(`${baseUrl}/api/users/${targetId}/role`, {
    method: "PATCH",
    headers: {
      authorization: `Bearer ${adminToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ role: "paralegal" }),
  });
  assert.equal(res.status, 200, `expected 200, got ${res.status}`);
  const body = (await res.json()) as { status: string; data: { role: string; id: number } };
  assert.equal(body.data.role, "paralegal");
  assert.equal(body.data.id, targetId);

  const afterRows = await db.execute(
    sql`SELECT role, token_version FROM mtos_users WHERE id = ${targetId}`,
  );
  const after =
    (afterRows as unknown as { rows?: Array<{ role: string; token_version: number }> }).rows ?? [];
  assert.equal(after[0]?.role, "paralegal", "DB row must reflect the new role");
  assert.equal(
    after[0]?.token_version,
    tvBefore + 1,
    "token_version MUST be bumped so old JWTs are rejected on next request",
  );
});

test("(d) PATCH against the caller's own row returns 403 cannot_change_own_role", async () => {
  const res = await fetch(`${baseUrl}/api/users/${adminId}/role`, {
    method: "PATCH",
    headers: {
      authorization: `Bearer ${adminToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ role: "viewer" }),
  });
  assert.equal(
    res.status,
    403,
    "admin must not be able to demote themselves — a sole admin could otherwise lock the firm out",
  );
  const body = (await res.json()) as { code?: string };
  assert.equal(
    body.code,
    "cannot_change_own_role",
    "self-edit denial must use a stable error code so the UI can render the correct message",
  );

  // Confirm the role was NOT changed despite the 403.
  const rows = await db.execute(
    sql`SELECT role FROM mtos_users WHERE id = ${adminId}`,
  );
  const r = (rows as unknown as { rows?: Array<{ role: string }> }).rows ?? [];
  assert.equal(r[0]?.role, "admin", "self-edit attempt must NOT mutate the row");
});

test("(e) PATCH against a user in a different firm returns 404 (no cross-firm leak)", async () => {
  const res = await fetch(`${baseUrl}/api/users/${otherFirmUserId}/role`, {
    method: "PATCH",
    headers: {
      authorization: `Bearer ${adminToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ role: "paralegal" }),
  });
  assert.equal(
    res.status,
    404,
    "user in another firm must read as 'not found' — returning 403 here would confirm the id exists",
  );

  // The other-firm user's role must be untouched.
  const rows = await db.execute(
    sql`SELECT role FROM mtos_users WHERE id = ${otherFirmUserId}`,
  );
  const r = (rows as unknown as { rows?: Array<{ role: string }> }).rows ?? [];
  assert.equal(r[0]?.role, "viewer", "cross-firm PATCH must not mutate the row");
});

test("(f) PATCH with role='admin' is rejected by zod (admin elevation is out-of-scope for this page)", async () => {
  // Capture role + token_version BEFORE the call so we can prove the
  // attempted elevation didn't slip through. Even an admin token must
  // not be able to mint another admin via this endpoint — that path is
  // deliberately closed off so a compromised admin can't quietly elevate
  // accounts and dodge the sole-admin self-edit guard.
  const before = await db.execute(
    sql`SELECT role, token_version FROM mtos_users WHERE id = ${targetId}`,
  );
  const beforeRow =
    (before as unknown as { rows?: Array<{ role: string; token_version: number }> }).rows?.[0];
  assert.ok(beforeRow, "target row must exist before the elevation attempt");

  const res = await fetch(`${baseUrl}/api/users/${targetId}/role`, {
    method: "PATCH",
    headers: {
      authorization: `Bearer ${adminToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ role: "admin" }),
  });
  assert.equal(
    res.status,
    400,
    "role='admin' must be rejected by the request schema (zod 400), not silently accepted",
  );

  const after = await db.execute(
    sql`SELECT role, token_version FROM mtos_users WHERE id = ${targetId}`,
  );
  const afterRow =
    (after as unknown as { rows?: Array<{ role: string; token_version: number }> }).rows?.[0];
  assert.equal(afterRow?.role, beforeRow.role, "rejected admin-elevation must NOT mutate role");
  assert.equal(
    afterRow?.token_version,
    beforeRow.token_version,
    "rejected admin-elevation must NOT bump token_version (no partial state)",
  );
});
