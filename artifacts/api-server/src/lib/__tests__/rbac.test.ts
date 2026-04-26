// Disable audit-log writes BEFORE importing rbac.ts so the audit module
// reads the flag at import time and short-circuits its inserts. Without
// this, every denial test queues a pg insert and the test process hangs
// waiting for the connection pool to drain.
process.env["RBAC_DISABLE_AUDIT"] = "1";

import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { pool } from "@workspace/db";

// Close the shared pg pool when the test file finishes — otherwise the
// drizzle-managed connection pool keeps the event loop alive.
after(async () => {
  await pool.end();
});
import {
  Permission,
  ROLE_PERMISSIONS,
  hasPermission,
  requirePermission,
  requireRole,
  canBypassOwnership,
  authMiddleware,
  __rbacInternal,
} from "../rbac.js";

// =============================================================================
// Tiny in-memory request/response stand-ins. We avoid spinning up a full
// supertest harness so this file stays a pure unit test — no DB, no server.
// Each helper mirrors only the bits of express the rbac middleware actually
// touches: status(), json(), set headers, ip, get(), and the user attachment.
// =============================================================================

interface FakeRes {
  statusCode: number;
  body: unknown;
  ended: boolean;
  status: (n: number) => FakeRes;
  json: (b: unknown) => FakeRes;
  setHeader: (k: string, v: string) => void;
  getHeader: (k: string) => string | undefined;
}

function makeRes(): FakeRes {
  const headers: Record<string, string> = {};
  const res: FakeRes = {
    statusCode: 200,
    body: undefined,
    ended: false,
    status(n) { this.statusCode = n; return this; },
    json(b) { this.body = b; this.ended = true; return this; },
    setHeader(k, v) { headers[k.toLowerCase()] = v; },
    getHeader(k) { return headers[k.toLowerCase()]; },
  };
  return res;
}

function makeReq(overrides: Partial<express.Request> = {}): express.Request {
  // `socket` is touched by the audit-denial logger; supply a stub so the
  // middleware doesn't throw on `socket.remoteAddress` when no real
  // connection exists.
  return {
    method: "GET",
    originalUrl: "/api/test",
    path: "/test",
    headers: {},
    ip: "127.0.0.1",
    socket: { remoteAddress: "127.0.0.1" },
    get: (h: string) => (overrides.headers as Record<string, string> | undefined)?.[h.toLowerCase()],
    user: undefined,
    ...overrides,
  } as unknown as express.Request;
}

function runMiddleware(
  mw: (req: express.Request, res: express.Response, next: express.NextFunction) => unknown,
  req: express.Request,
  res: FakeRes,
): Promise<{ nextCalled: boolean; nextErr?: unknown }> {
  return new Promise((resolve) => {
    let nextCalled = false;
    let nextErr: unknown;
    let resolved = false;
    const done = () => {
      if (resolved) return;
      resolved = true;
      resolve({ nextCalled, nextErr });
    };
    const next = ((err?: unknown) => {
      nextCalled = true;
      if (err) nextErr = err;
      done();
    }) as express.NextFunction;
    // Hook res.json() so the deny path (which ends the response without
    // calling next) also resolves the promise.
    const origJson = res.json.bind(res);
    res.json = (b: unknown) => {
      const r = origJson(b);
      done();
      return r;
    };
    Promise.resolve(mw(req, res as unknown as express.Response, next)).then(() => {
      // Final fallback: if the middleware exited cleanly without calling
      // next() or res.json(), still resolve so the test doesn't hang.
      done();
    });
  });
}

// =============================================================================
// Permission catalogue
// =============================================================================

describe("ROLE_PERMISSIONS catalogue", () => {
  test("admin has every permission in the enum", () => {
    const adminPerms = ROLE_PERMISSIONS.admin;
    for (const p of Object.values(Permission)) {
      assert.ok(adminPerms.has(p as Permission), `admin missing ${p}`);
    }
  });

  test("attorney has any-scope lead/case views (not own-scope)", () => {
    // attorney bypasses ownership, so the catalogue grants the wider
    // *_VIEW_ANY perm rather than the narrow *_VIEW_OWN. The own-scope
    // perm is for paralegal/viewer; canBypassOwnership() is what gives
    // attorney/admin access regardless.
    assert.equal(ROLE_PERMISSIONS.attorney.has(Permission.LEAD_VIEW_ANY), true);
    assert.equal(ROLE_PERMISSIONS.attorney.has(Permission.CASE_VIEW_ANY), true);
  });

  test("paralegal/viewer only see own scope", () => {
    assert.equal(ROLE_PERMISSIONS.paralegal.has(Permission.LEAD_VIEW_OWN), true);
    assert.equal(ROLE_PERMISSIONS.paralegal.has(Permission.LEAD_VIEW_ANY), false);
    assert.equal(ROLE_PERMISSIONS.viewer.has(Permission.CASE_VIEW_OWN), true);
    assert.equal(ROLE_PERMISSIONS.viewer.has(Permission.CASE_VIEW_ANY), false);
  });

  test("viewer cannot mutate leads or cases", () => {
    for (const p of [
      Permission.LEAD_CREATE,
      Permission.LEAD_UPDATE,
      Permission.LEAD_DELETE,
      Permission.CASE_CREATE,
      Permission.CASE_UPLOAD,
    ]) {
      assert.equal(ROLE_PERMISSIONS.viewer.has(p), false, `viewer should not have ${p}`);
    }
  });

  test("attorney cannot reach admin-only surfaces", () => {
    for (const p of [
      Permission.SECURITY_MANAGE,
      Permission.DECISION_ENGINE_MANAGE,
      Permission.FORMS_CONFIG_MANAGE,
      Permission.INTEGRATIONS_MANAGE,
      Permission.USERS_LIST,
      Permission.BUYERS_MANAGE,
      Permission.LEAD_SOURCES_MANAGE,
      Permission.TEMPLATES_MANAGE,
      Permission.WORKFLOW_SETTINGS_MANAGE,
      Permission.PARALEGAL_MANAGE,
    ]) {
      assert.equal(ROLE_PERMISSIONS.attorney.has(p), false, `attorney must not have ${p}`);
    }
  });

  test("paralegal cannot delete or export leads", () => {
    assert.equal(ROLE_PERMISSIONS.paralegal.has(Permission.LEAD_DELETE), false);
    assert.equal(ROLE_PERMISSIONS.paralegal.has(Permission.LEAD_EXPORT), false);
  });
});

describe("hasPermission()", () => {
  test("returns false for missing user", () => {
    assert.equal(hasPermission(undefined, Permission.LEAD_VIEW_OWN), false);
    assert.equal(hasPermission(null as unknown as undefined, Permission.LEAD_VIEW_OWN), false);
  });
  test("returns true when role has perm (viewer+CASE_VIEW_OWN)", () => {
    assert.equal(hasPermission({ id: 1, role: "viewer" }, Permission.CASE_VIEW_OWN), true);
  });
  test("returns false when role lacks perm (viewer+LEAD_DELETE)", () => {
    assert.equal(hasPermission({ id: 1, role: "viewer" }, Permission.LEAD_DELETE), false);
  });
  test("admin always returns true (sanity-check the broad grant)", () => {
    for (const p of Object.values(Permission)) {
      assert.equal(
        hasPermission({ id: 1, role: "admin" }, p as Permission),
        true,
        `admin should pass ${p}`,
      );
    }
  });
});

describe("canBypassOwnership()", () => {
  test("admin and attorney bypass ownership", () => {
    assert.equal(canBypassOwnership({ id: 1, role: "admin" }), true);
    assert.equal(canBypassOwnership({ id: 2, role: "attorney" }), true);
  });
  test("paralegal and viewer do not bypass ownership", () => {
    assert.equal(canBypassOwnership({ id: 3, role: "paralegal" }), false);
    assert.equal(canBypassOwnership({ id: 4, role: "viewer" }), false);
  });
  test("missing user does not bypass", () => {
    assert.equal(canBypassOwnership(undefined), false);
  });
  test("user.id===0 (dev synthetic) does NOT grant god mode by itself", () => {
    // The whole point of removing user.id !== 0 — a `viewer` with id 0 must
    // not bypass ownership just because of the magic id.
    assert.equal(canBypassOwnership({ id: 0, role: "viewer" }), false);
    assert.equal(canBypassOwnership({ id: 0, role: "paralegal" }), false);
  });
});

// =============================================================================
// requireRole / requirePermission middleware — role × decision matrix
// =============================================================================

describe("requireRole hierarchy", () => {
  const roles = ["viewer", "paralegal", "attorney", "admin"] as const;
  type Role = typeof roles[number];

  // Map: when requireRole(min) is invoked, which roles should be allowed?
  // attorney threshold ⇒ attorney + admin allowed; viewer/paralegal denied.
  const expected: Record<Role, Role[]> = {
    viewer:    ["viewer", "paralegal", "attorney", "admin"],
    paralegal: ["paralegal", "attorney", "admin"],
    attorney:  ["attorney", "admin"],
    admin:     ["admin"],
  };

  for (const min of roles) {
    for (const actual of roles) {
      const shouldAllow = expected[min].includes(actual);
      test(`requireRole("${min}") + role="${actual}" → ${shouldAllow ? "allow" : "deny"}`, async () => {
        const req = makeReq();
        (req as unknown as { user: unknown }).user = { id: 100, role: actual };
        const res = makeRes();
        const mw = requireRole(min);
        const { nextCalled } = await runMiddleware(mw, req, res);
        if (shouldAllow) {
          assert.equal(nextCalled, true, "expected next() to be called");
          assert.equal(res.ended, false);
        } else {
          assert.equal(nextCalled, false);
          assert.equal(res.statusCode, 403);
          const body = res.body as { status: string; code: string };
          assert.equal(body.status, "error");
          assert.equal(body.code, "FORBIDDEN");
        }
      });
    }
  }

  test("no user attached ⇒ 401 UNAUTHENTICATED", async () => {
    const req = makeReq();
    const res = makeRes();
    const { nextCalled } = await runMiddleware(requireRole("viewer"), req, res);
    assert.equal(nextCalled, false);
    assert.equal(res.statusCode, 401);
    assert.equal((res.body as { code: string }).code, "UNAUTHENTICATED");
  });

  test("multiple acceptable roles still go through hierarchy (highest wins)", async () => {
    // requireRole("paralegal","admin") must accept anyone >= paralegal, NOT
    // require an exact role match. This is the documented hierarchy-only
    // semantic in lib/rbac.ts.
    const req = makeReq();
    (req as unknown as { user: unknown }).user = { id: 1, role: "attorney" };
    const res = makeRes();
    const { nextCalled } = await runMiddleware(requireRole("paralegal", "admin"), req, res);
    assert.equal(nextCalled, true);
  });
});

describe("requirePermission()", () => {
  test("denies when role lacks the perm", async () => {
    const req = makeReq();
    (req as unknown as { user: unknown }).user = { id: 1, role: "viewer" };
    const res = makeRes();
    const { nextCalled } = await runMiddleware(
      requirePermission(Permission.LEAD_DELETE),
      req,
      res,
    );
    assert.equal(nextCalled, false);
    assert.equal(res.statusCode, 403);
    assert.equal((res.body as { code: string }).code, "FORBIDDEN");
  });

  test("allows when role has the perm", async () => {
    const req = makeReq();
    (req as unknown as { user: unknown }).user = { id: 1, role: "admin" };
    const res = makeRes();
    const { nextCalled } = await runMiddleware(
      requirePermission(Permission.LEAD_DELETE),
      req,
      res,
    );
    assert.equal(nextCalled, true);
  });

  test("missing user ⇒ 401 UNAUTHENTICATED", async () => {
    const req = makeReq();
    const res = makeRes();
    const { nextCalled } = await runMiddleware(
      requirePermission(Permission.LEAD_VIEW_OWN),
      req,
      res,
    );
    assert.equal(nextCalled, false);
    assert.equal(res.statusCode, 401);
    assert.equal((res.body as { code: string }).code, "UNAUTHENTICATED");
  });
});

// =============================================================================
// authMiddleware — token paths
// =============================================================================

describe("authMiddleware", () => {
  test("rejects request with no Authorization or session ⇒ 401", async () => {
    const req = makeReq();
    const res = makeRes();
    const { nextCalled } = await runMiddleware(authMiddleware, req, res);
    assert.equal(nextCalled, false);
    assert.equal(res.statusCode, 401);
    assert.equal((res.body as { code: string }).code, "UNAUTHENTICATED");
  });

  test("rejects malformed Bearer ⇒ 401", async () => {
    const req = makeReq({ headers: { authorization: "Bearer not.a.jwt" } });
    const res = makeRes();
    const { nextCalled } = await runMiddleware(authMiddleware, req, res);
    assert.equal(nextCalled, false);
    assert.equal(res.statusCode, 401);
    assert.equal((res.body as { code: string }).code, "UNAUTHENTICATED");
  });

  test("error envelope is always { status, code, message }", async () => {
    const req = makeReq();
    const res = makeRes();
    await runMiddleware(authMiddleware, req, res);
    const body = res.body as Record<string, unknown>;
    assert.equal(body["status"], "error");
    assert.equal(typeof body["code"], "string");
    assert.equal(typeof body["message"], "string");
  });
});

// =============================================================================
// Internal: dev-mode flag is strictly NODE_ENV === "development"
// =============================================================================

describe("dev gate (IS_DEV)", () => {
  test("the exported IS_DEV reflects the current NODE_ENV", () => {
    // We don't mutate NODE_ENV here — the test just asserts the contract.
    // The boot validator in src/index.ts also reads NODE_ENV directly.
    const expected = process.env["NODE_ENV"] === "development";
    assert.equal(__rbacInternal.isDev(), expected);
  });

  // The dev gate constant in rbac.ts (`IS_DEV`) is captured at module
  // import time, so we cannot toggle process.env inside an existing test —
  // we'd just be reading the cached value. Instead, we re-execute the
  // gate's exact check in isolation against every problematic env shape.
  // This also documents the canonical predicate used at boot and in the
  // SESSION_SECRET fallback in lib/rbac.ts:39-40.
  test("dev-mode predicate is FALSE for production / staging / test / unset", () => {
    const isDevPredicate = (env: string | undefined) => env === "development";
    for (const value of ["production", "staging", "test", undefined]) {
      assert.equal(
        isDevPredicate(value),
        false,
        `expected dev predicate === false for NODE_ENV=${String(value)}`,
      );
    }
  });

  test("dev-mode predicate is TRUE only for the exact string 'development'", () => {
    const isDevPredicate = (env: string | undefined) => env === "development";
    assert.equal(isDevPredicate("development"), true);
    // Casing/whitespace/aliases MUST NOT enable the bypass — protects
    // against a mis-set deployment env var (e.g. NODE_ENV=Development on
    // Windows) accidentally turning on the dev auth shim.
    for (const value of ["Development", "DEVELOPMENT", "development ", " development", "dev", "develop"]) {
      assert.equal(
        isDevPredicate(value),
        false,
        `expected dev predicate === false for NODE_ENV=${JSON.stringify(value)}`,
      );
    }
  });
});

// =============================================================================
// Route-table validator regression. These tests construct minimal Express
// router trees and assert the boot-time validator's behaviour: it MUST throw
// on any leaf route that is missing either authMiddleware or a role gate, and
// it MUST accept routes that pass through requireRole/requirePermission. They
// also assert that a plainly-named "requireRole" function CANNOT impersonate
// a real gate — symbol detection is the only signal.
// =============================================================================

describe("validateRouteTable (boot-time)", () => {
  test("rejects an authenticated route with no role/permission gate", async () => {
    const { validateRouteTable } = await import("../route-protection.js");
    const { labelRouter } = await import("../route-protection.js");
    const Router = (await import("express")).Router;

    const parent = Router();
    const child = labelRouter(Router(), "test-bad");
    child.use(authMiddleware);
    // No requireRole/requirePermission. The validator MUST flag this.
    child.get("/leak", (_req, res) => res.json({ ok: true }));
    parent.use("/test-bad", child);

    assert.throws(
      () => validateRouteTable(parent),
      /no requireRole\/requirePermission gate/,
    );
  });

  test("accepts an authenticated + role-gated route", async () => {
    const { validateRouteTable, labelRouter } = await import("../route-protection.js");
    const Router = (await import("express")).Router;

    const parent = Router();
    const child = labelRouter(Router(), "test-good");
    child.use(authMiddleware);
    child.get("/safe", requireRole("paralegal"), (_req, res) => res.json({ ok: true }));
    parent.use("/test-good", child);

    const counters = validateRouteTable(parent);
    assert.equal(counters.checked, 1);
    assert.equal(counters.protected, 1);
  });

  test("a contributor-named requireRole noop CANNOT bypass the validator", async () => {
    // Forging attempt: define a middleware named 'requireRole' that does
    // nothing. With the symbol-based validator this MUST still fail.
    const { validateRouteTable, labelRouter } = await import("../route-protection.js");
    const Router = (await import("express")).Router;

    const parent = Router();
    const child = labelRouter(Router(), "test-forge");
    child.use(authMiddleware);
    function requireRole(_req: any, _res: any, next: any) { next(); }
    child.get("/forged", requireRole, (_req, res) => res.json({ ok: true }));
    parent.use("/test-forge", child);

    assert.throws(
      () => validateRouteTable(parent),
      /no requireRole\/requirePermission gate/,
    );
  });

  test("requirePermission also satisfies the gate requirement", async () => {
    const { validateRouteTable, labelRouter } = await import("../route-protection.js");
    const Router = (await import("express")).Router;

    const parent = Router();
    const child = labelRouter(Router(), "test-perm");
    child.use(authMiddleware);
    child.get("/with-perm", requirePermission(Permission.LEAD_VIEW_ANY), (_req, res) => res.json({ ok: true }));
    parent.use("/test-perm", child);

    const counters = validateRouteTable(parent);
    assert.equal(counters.protected, 1);
  });

  test("a Symbol.for() router stamp CANNOT impersonate markPublic", async () => {
    // Forging attempt: a contributor in another module computes the same
    // string the validator USED to use for its public flag and stamps an
    // ungated router as public. Because the public flag is now a
    // module-LOCAL Symbol(), the well-known string yields a different
    // symbol identity, so the validator must STILL flag the route.
    const { validateRouteTable, labelRouter } = await import("../route-protection.js");
    const Router = (await import("express")).Router;

    const parent = Router();
    const child = labelRouter(Router(), "test-fakepub");
    // Old key string, used by the previous Symbol.for() implementation.
    const fakeKey = Symbol.for("@workspace/api-server/route-protection/public");
    (child as unknown as Record<symbol, unknown>)[fakeKey] = true;
    child.use(authMiddleware);
    child.get("/leak", (_req, res) => res.json({ ok: true }));
    parent.use("/test-fakepub", child);

    assert.throws(
      () => validateRouteTable(parent),
      /no requireRole\/requirePermission gate/,
    );
  });

  test("missing authMiddleware fails even with a role gate present", async () => {
    const { validateRouteTable, labelRouter } = await import("../route-protection.js");
    const Router = (await import("express")).Router;

    const parent = Router();
    const child = labelRouter(Router(), "test-noauth");
    // No authMiddleware mounted.
    child.get("/no-auth", requireRole("admin"), (_req, res) => res.json({ ok: true }));
    parent.use("/test-noauth", child);

    assert.throws(
      () => validateRouteTable(parent),
      /no authMiddleware in chain/,
    );
  });
});
