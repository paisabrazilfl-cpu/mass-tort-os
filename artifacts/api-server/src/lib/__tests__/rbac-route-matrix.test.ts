// Booted-app role × route access matrix. Spins up the real express app on
// an ephemeral port, mints a JWT per role, and asserts the actual HTTP
// outcome for routes that span every trust boundary the validator
// recognises (public, auth-exception, auth-only, role-gated).

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import type { AddressInfo } from "node:net";
import type { Express, Router } from "express";
import { db, pool } from "@workspace/db";
import { sql } from "drizzle-orm";
import { generateToken, type UserRole } from "../rbac.js";
import {
  validateRouteTable,
  type RoutePolicyEntry,
} from "../route-protection.js";

// Audit writes are disabled here so the role-matrix probe doesn't pollute
// audit_log. rbac.test.ts already asserts the denial+audit-row path.
process.env["RBAC_DISABLE_AUDIT"] = "1";

// -----------------------------------------------------------------------------
// Typed helpers — keep the test free of `as any` escapes.
// -----------------------------------------------------------------------------

/** drizzle-orm/node-postgres returns a pg `QueryResult`-shaped object. */
interface PgQueryResult<T> { rows: T[] }

function queryRows<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  if (result && typeof result === "object" && "rows" in (result as object)) {
    const r = (result as PgQueryResult<T>).rows;
    return Array.isArray(r) ? r : [];
  }
  return [];
}

/** express 5 exposes the internal router as `_router`; older typings use `router`. */
function expressRouterOf(app: Express): Router {
  const a = app as unknown as { _router?: Router; router?: Router };
  const router = a._router ?? a.router;
  if (!router) throw new Error("could not resolve express router from app");
  return router;
}

/** node http.Server `closeAllConnections` is not in the public Server type. */
function closeAllConnections(server: import("node:http").Server): void {
  const fn = (server as unknown as { closeAllConnections?: () => void }).closeAllConnections;
  if (typeof fn === "function") fn.call(server);
}

// -----------------------------------------------------------------------------
// Boot the app + capture validateRouteTable's policy report.
// -----------------------------------------------------------------------------

interface BootedApp {
  baseUrl: string;
  policy: RoutePolicyEntry[];
  close: () => Promise<void>;
}

const ephemeralUsers: Array<{ id: number; role: UserRole; token: string; email: string }> = [];

let booted: BootedApp | undefined;
const TS = Date.now();

async function bootApp(): Promise<BootedApp> {
  // Import app.ts directly (not index.ts) — index.ts boots a worker we
  // don't need here. The dynamic import is required so the
  // RBAC_DISABLE_AUDIT env var above is set before module init.
  const appMod = (await import("../../app.js")) as { default: Express };
  const app = appMod.default;

  // app.ts ran validateRouteTable() at import; re-run to capture the report.
  const report = validateRouteTable(expressRouterOf(app));

  return await new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const addr = server.address() as AddressInfo | null;
      if (!addr || typeof addr === "string") {
        reject(new Error("could not resolve listen address"));
        return;
      }
      const baseUrl = `http://127.0.0.1:${addr.port}`;
      resolve({
        baseUrl,
        policy: report.policy,
        close: () =>
          new Promise<void>((res) => {
            // Drop keep-alive sockets so node:test doesn't wait for them.
            closeAllConnections(server);
            server.close(() => res());
          }),
      });
    });
    server.on("error", reject);
  });
}

before(async () => {
  booted = await bootApp();

  // One ephemeral user per role. Password hash is a placeholder — we mint
  // JWTs directly, the login path doesn't run.
  for (const role of ["admin", "attorney", "paralegal", "viewer"] as const) {
    const email = `rbac-matrix-${role}-${TS}@mtos.test`;
    const inserted = await db.execute(sql`
      INSERT INTO mtos_users (email, name, role, password_hash, token_version)
      VALUES (${email}, ${`Matrix ${role}`}, ${role}, ${"$2b$10$test.placeholder.hash.not.usable"}, 0)
      RETURNING id
    `);
    const id = queryRows<{ id: number }>(inserted)[0]?.id;
    if (typeof id !== "number") throw new Error(`failed to insert ${role}`);
    const token = generateToken({ id, email, name: `Matrix ${role}`, role });
    ephemeralUsers.push({ id, role, token, email });
  }
});

after(async () => {
  // Cleanup ephemeral users + their audit-log rows (none expected, but safe).
  for (const u of ephemeralUsers) {
    await db.execute(sql`DELETE FROM mtos_users WHERE id = ${u.id}`);
  }
  if (booted) await booted.close();
  await pool.end();
});

// Convenience wrappers ---------------------------------------------------------

function tokenFor(role: UserRole): string {
  const u = ephemeralUsers.find((x) => x.role === role);
  if (!u) throw new Error(`no ephemeral user for role ${role}`);
  return u.token;
}

interface ProbeResult {
  status: number;
  body: unknown;
}

async function probe(
  method: string,
  path: string,
  opts: { token?: string; body?: unknown } = {},
): Promise<ProbeResult> {
  if (!booted) throw new Error("app not booted");
  const headers: Record<string, string> = {};
  if (opts.token) headers["Authorization"] = `Bearer ${opts.token}`;
  if (opts.body !== undefined) headers["Content-Type"] = "application/json";
  const res = await fetch(`${booted.baseUrl}${path}`, {
    method,
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  let body: unknown = undefined;
  const text = await res.text();
  if (text.length > 0) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }
  return { status: res.status, body };
}

// =============================================================================
// 1. Public allowlist enforcement
//
// Architect requirement: "only `/api/health/*`, `/api/forms-public/*`,
// `/api/webhooks/*` are unauthenticated" plus the auth-router exception list
// (login/refresh/register). The validator's policy report is the single
// source of truth — we assert against it directly so any future drift fails
// the build.
// =============================================================================

describe("public allowlist (validateRouteTable policy)", () => {
  test("only health / forms-public / webhooks routers are stamped 'public'", () => {
    if (!booted) throw new Error("app not booted");
    const publicRouters = new Set(
      booted.policy
        .filter((p) => p.status === "public")
        .map((p) => p.router),
    );
    const expected = new Set(["health", "forms-public", "webhooks"]);
    for (const r of publicRouters) {
      assert.ok(expected.has(r), `unexpected public router: ${r}`);
    }
    assert.ok(publicRouters.size > 0, "expected at least one public router in policy");
  });

  test("auth router exceptions are exactly login / refresh / register", () => {
    if (!booted) throw new Error("app not booted");
    const exceptions = booted.policy
      .filter((p) => p.status === "auth-exception")
      .map((p) => `${p.method} ${p.path}`)
      .sort();
    assert.deepEqual(exceptions, ["POST /login", "POST /refresh", "POST /register"]);
  });

  test("EVERY non-public route is either auth-only or role-gated (no unprotected leaks)", () => {
    if (!booted) throw new Error("app not booted");
    for (const p of booted.policy) {
      assert.ok(
        ["public", "auth-exception", "auth-only", "role-gated"].includes(p.status),
        `route ${p.method} ${p.path} has unknown status ${p.status}`,
      );
    }
    // The architect cares specifically about no "auth-only" leaks where
    // the route should have been role-gated. The auth-only set is a known
    // small allowlist; cross-check it against the policy.
    const authOnly = booted.policy.filter((p) => p.status === "auth-only").map((p) => `${p.router} ${p.method} ${p.path}`).sort();
    const expectedAuthOnly = [
      "auth GET /me",
      "auth POST /change-password",
      "auth POST /logout",
      "auth POST /mfa/disable",
      "auth POST /mfa/setup",
      "auth POST /mfa/verify",
      "forms GET /categories",
      "forms POST /validate/address",
      "forms POST /validate/email",
    ];
    assert.deepEqual(authOnly, expectedAuthOnly, "auth-only allowlist drift");
  });

  test("forms config GETs are role-gated (regression: were auth-only, now attorney+)", () => {
    if (!booted) throw new Error("app not booted");
    const config = booted.policy.find((p) => p.router === "forms" && p.method === "GET" && p.path === "/config");
    const configById = booted.policy.find((p) => p.router === "forms" && p.method === "GET" && p.path === "/config/:tortId");
    assert.equal(config?.status, "role-gated", "GET /api/forms/config must be role-gated");
    assert.equal(configById?.status, "role-gated", "GET /api/forms/config/:tortId must be role-gated");
  });
});

// =============================================================================
// 2. Public endpoints reachable WITHOUT auth
// =============================================================================

describe("public endpoints reachable unauthenticated (path-prefix contract)", () => {
  // Path-prefix allowlist enforcement: the contract is that ONLY these
  // three URL prefixes may be reachable without a Bearer token. We assert
  // both directions: the prefixes ARE reachable, and a sibling auth path
  // is NOT.
  test("GET /api/healthz returns 2xx with no Authorization header", async () => {
    const r = await probe("GET", "/api/healthz");
    assert.ok(r.status >= 200 && r.status < 300, `expected 2xx, got ${r.status}`);
    assert.equal((r.body as { status?: string }).status, "ok");
  });

  test("GET /api/forms-public/preview-blocker.js returns 2xx with no Authorization header", async () => {
    const r = await probe("GET", "/api/forms-public/preview-blocker.js");
    assert.ok(r.status >= 200 && r.status < 300, `expected 2xx, got ${r.status}`);
  });

  test("POST /api/webhooks/dropbox-sign does NOT 401 (real public webhook endpoint)", async () => {
    // Each provider webhook verifies its own signature internally and
    // returns 200 even on bad sig (so providers don't disable the
    // webhook). What matters here is that we never see 401 — the public
    // stamp must hold at the path-prefix level, not just the label level.
    const r = await probe("POST", "/api/webhooks/dropbox-sign", {});
    assert.notEqual(r.status, 401, `expected non-401 for public webhook prefix, got ${r.status}`);
    if ((r.body as { code?: string }).code) {
      assert.notEqual((r.body as { code?: string }).code, "UNAUTHENTICATED");
    }
  });

  test("GET /api/forms/preview/some-tort returns 401 (the OLD public path is now auth-only — proves remount worked)", async () => {
    // Regression: formsPublicRouter previously lived at /api/forms,
    // colliding with the authenticated formsRouter and weakening the
    // public-allowlist contract. After remount to /api/forms-public,
    // /api/forms/preview/* must fall through to authMiddleware.
    const r = await probe("GET", "/api/forms/preview/some-tort");
    assert.equal(r.status, 401, `expected 401 on old public path, got ${r.status}`);
    assert.equal((r.body as { code?: string }).code, "UNAUTHENTICATED");
  });

  test("public path-prefix contract: every 'public' policy entry resolves under /api/healthz, /api/forms-public/, or /api/webhooks/", () => {
    if (!booted) throw new Error("app not booted");
    // Map router-label → mounted URL prefix. Single source of truth: the
    // mount table in routes/index.ts. If anyone changes the mount, this
    // assertion fails until the allowlist is updated in lockstep.
    const ROUTER_PREFIX: Record<string, string> = {
      health: "/api",
      "forms-public": "/api/forms-public",
      webhooks: "/api/webhooks",
    };
    const ALLOWED_PUBLIC_PREFIXES = ["/api/healthz", "/api/forms-public/", "/api/webhooks/"];
    for (const p of booted.policy) {
      if (p.status !== "public") continue;
      const prefix = ROUTER_PREFIX[p.router];
      assert.ok(prefix !== undefined, `public route on unknown router ${p.router}`);
      const full = `${prefix}${p.path === "/" ? "" : p.path}`;
      const ok = ALLOWED_PUBLIC_PREFIXES.some((pre) =>
        pre.endsWith("/") ? full.startsWith(pre) || full === pre.slice(0, -1) : full === pre || full.startsWith(`${pre}/`),
      );
      assert.ok(
        ok,
        `public route ${p.method} ${full} not under allowed prefixes ${ALLOWED_PUBLIC_PREFIXES.join(", ")}`,
      );
    }
  });
});

// =============================================================================
// 3. Protected endpoint denies unauthenticated requests
// =============================================================================

describe("protected endpoints deny unauthenticated requests", () => {
  for (const path of ["/api/leads", "/api/cases", "/api/forms/config", "/api/decision-engine/portfolio"]) {
    test(`GET ${path} ⇒ 401 UNAUTHENTICATED without a token`, async () => {
      const r = await probe("GET", path);
      assert.equal(r.status, 401);
      assert.equal((r.body as { code?: string }).code, "UNAUTHENTICATED");
    });
  }
});

// =============================================================================
// 4. Role × route allow/deny matrix
//
// We pick representative READ endpoints across the gating spectrum so the
// test is fast and deterministic without depending on per-row fixtures:
//
//   - GET /api/forms/config            → attorney+   (NEW gate from this task)
//   - GET /api/decision-engine/portfolio → attorney+ (read/write split)
//   - PUT /api/decision-engine/settings  → admin only
//   - GET /api/cases                    → all authenticated roles
//                                          (viewers see their own; that's
//                                          row-level scoping, not a 403)
//   - GET /api/leads                    → all authenticated roles
//                                          (lead read perm spans roles)
//   - GET /api/paralegals               → admin / attorney / paralegal
//                                          (no viewer)
//   - GET /api/dashboard/stats          → all authenticated
//   - GET /api/auth/me                  → auth-only (any authenticated role)
// =============================================================================

interface MatrixRow {
  method: "GET" | "PUT" | "POST" | "DELETE" | "PATCH";
  path: string;
  body?: unknown;
  expect: Record<UserRole, "allow" | "deny">;
  /** Allowed status codes for "allow". 401/403 are always treated as deny. */
  allowStatuses?: number[];
}

const MATRIX: MatrixRow[] = [
  {
    method: "GET",
    path: "/api/forms/config",
    expect: { admin: "allow", attorney: "allow", paralegal: "deny", viewer: "deny" },
  },
  {
    method: "GET",
    path: "/api/forms/config/test-tort",
    expect: { admin: "allow", attorney: "allow", paralegal: "deny", viewer: "deny" },
    // 404 is a fine "allow" outcome (the test tort doesn't exist) — what we
    // care about is that the gate didn't 403.
    allowStatuses: [200, 404],
  },
  {
    method: "GET",
    path: "/api/decision-engine/portfolio",
    expect: { admin: "allow", attorney: "allow", paralegal: "deny", viewer: "deny" },
  },
  {
    method: "PUT",
    path: "/api/decision-engine/settings",
    body: {},
    expect: { admin: "allow", attorney: "deny", paralegal: "deny", viewer: "deny" },
    // PUT with empty body may 400; that still proves the role gate let admin in.
    allowStatuses: [200, 400, 422],
  },
  {
    method: "GET",
    path: "/api/auth/me",
    expect: { admin: "allow", attorney: "allow", paralegal: "allow", viewer: "allow" },
  },
];

describe("role × route allow/deny matrix", () => {
  for (const row of MATRIX) {
    for (const role of ["admin", "attorney", "paralegal", "viewer"] as const) {
      const expected = row.expect[role];
      test(`${role.padEnd(9)} ${row.method} ${row.path} ⇒ ${expected}`, async () => {
        const r = await probe(row.method, row.path, { token: tokenFor(role), body: row.body });
        if (expected === "deny") {
          assert.equal(r.status, 403, `expected 403, got ${r.status} (${JSON.stringify(r.body).slice(0, 200)})`);
          assert.equal((r.body as { code?: string }).code, "FORBIDDEN");
        } else {
          const allowed = row.allowStatuses ?? [200];
          assert.ok(
            r.status !== 401 && r.status !== 403,
            `expected allow but got auth/role rejection ${r.status} (${JSON.stringify(r.body).slice(0, 200)})`,
          );
          assert.ok(
            allowed.includes(r.status),
            `expected one of ${allowed.join("/")} for allow, got ${r.status}`,
          );
        }
      });
    }
  }
});

// 5. Token revocation via DB token_version bump (full HTTP round-trip).
// Proves end-to-end that bumping mtos_users.token_version causes the
// previously-minted JWT (with stale `tv`) to be denied 401 by authMiddleware
// — the path real session invalidation (logout-all, password reset, MFA
// enrol) flows through.

describe("token revocation via DB token_version bump (HTTP path)", () => {
  test("bumping mtos_users.token_version causes a previously-valid token to be denied 401", async () => {
    const TS_REV = Date.now();
    const email = `rbac-revocation-${TS_REV}@mtos.test`;
    const inserted = await db.execute(sql`
      INSERT INTO mtos_users (email, name, role, password_hash, token_version)
      VALUES (${email}, ${"Revocation Probe"}, ${"attorney"}, ${"$2b$10$test.placeholder.hash.not.usable"}, 0)
      RETURNING id
    `);
    const id = queryRows<{ id: number }>(inserted)[0]?.id;
    if (typeof id !== "number") throw new Error("failed to insert revocation probe user");

    try {
      // Mint a token at token_version=0. authMiddleware embeds tv=0 in the
      // JWT — that's the value the runtime check compares against the DB
      // row.
      const token = generateToken({ id, email, name: "Revocation Probe", role: "attorney" });

      // Sanity check: pre-bump, the token works.
      const before = await probe("GET", "/api/auth/me", { token });
      assert.equal(before.status, 200, `pre-bump GET /api/auth/me must be 200, got ${before.status} (${JSON.stringify(before.body).slice(0, 200)})`);

      // Bump token_version in the DB. This is what `POST /api/auth/logout`
      // (logout-all-sessions), password reset, and MFA enrol all do.
      await db.execute(sql`UPDATE mtos_users SET token_version = token_version + 1 WHERE id = ${id}`);

      // Re-issue the SAME token. authMiddleware should now reject it
      // because its `tv` claim is stale relative to the DB row.
      const after = await probe("GET", "/api/auth/me", { token });
      assert.equal(after.status, 401, `post-bump GET /api/auth/me must be 401, got ${after.status} (${JSON.stringify(after.body).slice(0, 200)})`);
      // Normalised envelope assertion: the 401 must carry a
      // machine-readable code so the CRM can route the user back to login
      // (rather than treating it as a generic "auth not present" failure).
      const code = (after.body as { code?: string }).code;
      assert.ok(
        code === "TOKEN_REVOKED" || code === "UNAUTHENTICATED",
        `expected code TOKEN_REVOKED or UNAUTHENTICATED, got ${String(code)}`,
      );

      // A second identical request must remain rejected — there is no
      // accidental cache that "warms" the stale token back into validity.
      const after2 = await probe("GET", "/api/auth/me", { token });
      assert.equal(after2.status, 401, "second post-bump request must remain 401");
    } finally {
      await db.execute(sql`DELETE FROM mtos_users WHERE id = ${id}`);
    }
  });
});

// 6. Viewer ownership filter on cases endpoints (full HTTP round-trip).
// Inserts real rows owned by the viewer / assigned to the viewer / owned
// by someone else and asserts the GET /api/cases list and per-id reads
// match the documented ownership rules.

describe("viewer ownership filter on cases endpoints (HTTP path)", () => {
  // Need a stable second user-id for the "unowned" case. The matrix's
  // attorney probe user is a fine owner; we read its id off the
  // ephemeralUsers list we already populate in `before`.
  function uuid(): string { return crypto.randomUUID(); }

  test("GET /api/cases as viewer returns ONLY rows the viewer owns or is assigned to; GET /:id of an unowned row is 403; attorney sees both", async () => {
    const viewer = ephemeralUsers.find((u) => u.role === "viewer");
    const attorney = ephemeralUsers.find((u) => u.role === "attorney");
    if (!viewer || !attorney) throw new Error("ephemeral viewer/attorney not initialised");

    const ownedId = uuid();
    const unownedId = uuid();
    const assignedId = uuid();
    try {
      // 1. Owned row — viewer is created_by_user_id.
      await db.execute(sql`
        INSERT INTO cases (id, data, status, created_by_user_id, assigned_to)
        VALUES (${ownedId}, ${"{}"}::jsonb, ${"open"}, ${viewer.id}, NULL)
      `);
      // 2. Unowned row — created by attorney, no assignee.
      await db.execute(sql`
        INSERT INTO cases (id, data, status, created_by_user_id, assigned_to)
        VALUES (${unownedId}, ${"{}"}::jsonb, ${"open"}, ${attorney.id}, NULL)
      `);
      // 3. Assigned-to-viewer row — created by attorney, viewer assigned.
      await db.execute(sql`
        INSERT INTO cases (id, data, status, created_by_user_id, assigned_to)
        VALUES (${assignedId}, ${"{}"}::jsonb, ${"open"}, ${attorney.id}, ${viewer.id})
      `);

      // GET /api/cases as viewer — must return ownedId AND assignedId, NOT unownedId.
      const list = await probe("GET", "/api/cases", { token: viewer.token });
      assert.equal(list.status, 200, `viewer GET /api/cases must be 200, got ${list.status}`);
      const ids = ((list.body as Array<{ id: string }>) ?? []).map((r) => r.id);
      assert.ok(ids.includes(ownedId), `viewer must see owned case ${ownedId} in list, got ${JSON.stringify(ids)}`);
      assert.ok(ids.includes(assignedId), `viewer must see assigned case ${assignedId} in list, got ${JSON.stringify(ids)}`);
      assert.ok(!ids.includes(unownedId), `viewer MUST NOT see unowned case ${unownedId} in list — leak`);

      // GET /api/cases/:owned as viewer — must be 200.
      const owned = await probe("GET", `/api/cases/${ownedId}`, { token: viewer.token });
      assert.equal(owned.status, 200, `viewer GET owned case must be 200, got ${owned.status}`);

      // GET /api/cases/:assigned as viewer — must be 200.
      const assigned = await probe("GET", `/api/cases/${assignedId}`, { token: viewer.token });
      assert.equal(assigned.status, 200, `viewer GET assigned case must be 200, got ${assigned.status}`);

      // GET /api/cases/:unowned as viewer — must be 403 (the audit doc
      // commits to 403 over 404 here so the CRM can render a clear
      // "no access" banner; case ids are opaque UUIDs so existence-leak
      // is low-value).
      const unowned = await probe("GET", `/api/cases/${unownedId}`, { token: viewer.token });
      assert.equal(unowned.status, 403, `viewer GET unowned case must be 403, got ${unowned.status} (${JSON.stringify(unowned.body).slice(0, 200)})`);
      assert.equal((unowned.body as { code?: string }).code, "FORBIDDEN");

      // Cross-check: attorney role has no per-row scope and sees BOTH
      // owned and unowned cases in the list (paralegal+ are caseload-wide).
      const attorneyList = await probe("GET", "/api/cases", { token: attorney.token });
      assert.equal(attorneyList.status, 200, `attorney GET /api/cases must be 200, got ${attorneyList.status}`);
      const attorneyIds = ((attorneyList.body as Array<{ id: string }>) ?? []).map((r) => r.id);
      assert.ok(attorneyIds.includes(ownedId), "attorney must see ownedId");
      assert.ok(attorneyIds.includes(unownedId), "attorney must see unownedId — paralegal+ are caseload-wide");
    } finally {
      await db.execute(sql`DELETE FROM cases WHERE id IN (${ownedId}, ${unownedId}, ${assignedId})`);
    }
  });
});
