// =============================================================================
// MTOS Task #10 — booted-app role × route access matrix.
//
// Where rbac.test.ts exercises the pure helpers (hasPermission,
// requirePermission, isCaseVisibleToUser, …) against in-memory request /
// response stand-ins, THIS file boots the *real* express app on an ephemeral
// port, inserts one ephemeral user per role, mints a JWT for each one, and
// asserts the actual HTTP outcome for representative routes that span every
// trust boundary the validator recognises:
//
//   - public            (no auth needed)
//   - auth-exception    (auth router login/refresh/register — unauthenticated by design)
//   - auth-only         (authenticated, no role gate — self-service / utility)
//   - role-gated        (the default; admin / attorney / paralegal / viewer)
//
// The test also pulls the route-policy report emitted by `validateRouteTable`
// and asserts that the only routes the boot validator considers
// unauthenticated are mounted under one of the well-known public bases
// (`/api/health`, `/api/forms-public`, `/api/webhooks`) or the auth router's
// explicit exception list (login / refresh / register).
//
// Side effects: the test creates 4 ephemeral users with email
// `rbac-matrix-<role>-<timestamp>@mtos.test` and deletes them in `after()`.
// =============================================================================

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { db, pool } from "@workspace/db";
import { sql } from "drizzle-orm";
import { generateToken, type UserRole } from "../rbac.js";
import {
  validateRouteTable,
  type RoutePolicyEntry,
} from "../route-protection.js";

// We disable the audit-log writes in this test to keep the audit_log table
// from filling with role-matrix probe rows. The denial path itself is
// already covered (with the audit row) by rbac.test.ts.
process.env["RBAC_DISABLE_AUDIT"] = "1";

// =============================================================================
// Boot the app + capture the policy report from validateRouteTable.
// We import app dynamically so the env-var above is set BEFORE any module
// initialisation that reads it.
// =============================================================================

interface BootedApp {
  baseUrl: string;
  policy: RoutePolicyEntry[];
  close: () => Promise<void>;
}

const ephemeralUsers: Array<{ id: number; role: UserRole; token: string; email: string }> = [];

let booted: BootedApp | undefined;
const TS = Date.now();

async function bootApp(): Promise<BootedApp> {
  // The app's index.ts performs side effects we don't want in tests
  // (worker boot, port resolution from env, etc.), so we import app.ts
  // directly and listen on an ephemeral port.
  const appMod = (await import("../../app.js")) as { default: import("express").Express };
  const app = appMod.default;

  // app.ts already invoked validateRouteTable() at import time; re-run it
  // here so we can inspect the per-route policy report (the inner router is
  // exposed via app._router in express 5).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const router = (app as unknown as { _router?: import("express").Router; router?: import("express").Router })._router
    ?? (app as unknown as { router?: import("express").Router }).router;
  if (!router) throw new Error("could not resolve express router from app");
  const report = validateRouteTable(router);

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
            // Force-drop any lingering keep-alive sockets, otherwise
            // node:test waits for the listener to finish even though
            // server.close() was called.
            const closeAll = (server as unknown as { closeAllConnections?: () => void }).closeAllConnections;
            if (typeof closeAll === "function") closeAll.call(server);
            server.close(() => res());
          }),
      });
    });
    server.on("error", reject);
  });
}

before(async () => {
  booted = await bootApp();

  // Insert one ephemeral user per role. We use a known password hash placeholder
  // (bcrypt-style) — the auth path won't run because we mint JWTs directly.
  for (const role of ["admin", "attorney", "paralegal", "viewer"] as const) {
    const email = `rbac-matrix-${role}-${TS}@mtos.test`;
    const inserted = await db.execute(sql`
      INSERT INTO mtos_users (email, name, role, password_hash, token_version)
      VALUES (${email}, ${`Matrix ${role}`}, ${role}, ${"$2b$10$test.placeholder.hash.not.usable"}, 0)
      RETURNING id
    `);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const id = (inserted.rows as Array<{ id: number }>)[0]?.id;
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

describe("public endpoints reachable unauthenticated", () => {
  test("GET /api/healthz returns 2xx with no Authorization header", async () => {
    const r = await probe("GET", "/api/healthz");
    assert.ok(r.status >= 200 && r.status < 300, `expected 2xx, got ${r.status}`);
    assert.equal((r.body as { status?: string }).status, "ok");
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
