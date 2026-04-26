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
  generateToken,
  isTokenVersionRevoked,
  __rbacInternal,
} from "../rbac.js";
import { isCaseVisibleToUser } from "../../routes/cases.js";

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

  // ---------------------------------------------------------------------------
  // Variadic contract — task #10 explicitly requires `requirePermission(...perms)`
  // with any-of semantics so callers can express "may view own OR view any".
  // ---------------------------------------------------------------------------

  test("variadic: passes when role grants ANY one of the listed perms (any-of)", async () => {
    // viewer has LEAD_VIEW_OWN but not LEAD_VIEW_ANY. The any-of gate must
    // accept them when EITHER perm is acceptable.
    const req = makeReq();
    (req as unknown as { user: unknown }).user = { id: 1, role: "viewer" };
    const res = makeRes();
    const { nextCalled } = await runMiddleware(
      requirePermission(Permission.LEAD_VIEW_ANY, Permission.LEAD_VIEW_OWN),
      req,
      res,
    );
    assert.equal(nextCalled, true, "viewer with LEAD_VIEW_OWN should pass any-of gate");
  });

  test("variadic: denies when role grants NONE of the listed perms", async () => {
    const req = makeReq();
    (req as unknown as { user: unknown }).user = { id: 1, role: "viewer" };
    const res = makeRes();
    const { nextCalled } = await runMiddleware(
      requirePermission(Permission.LEAD_DELETE, Permission.LEAD_EXPORT),
      req,
      res,
    );
    assert.equal(nextCalled, false);
    assert.equal(res.statusCode, 403);
  });

  test("variadic: zero perms throws at mount time (deny-all guard)", () => {
    assert.throws(
      () => requirePermission(),
      /refusing to mount a deny-all middleware/,
    );
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

// =============================================================================
// Token revocation — pure helper
//
// The end-to-end "DB token_version mismatch ⇒ 401" path requires a live pg
// connection, which intentionally lives outside this unit-test file. The
// comparison logic ITSELF is factored into `isTokenVersionRevoked()` so we
// can assert every interesting boundary here without mocking drizzle.
// =============================================================================

describe("isTokenVersionRevoked()", () => {
  test("legacy token without tv claim is never revoked (rely on JWT expiry)", () => {
    assert.equal(isTokenVersionRevoked(undefined, 0), false);
    assert.equal(isTokenVersionRevoked(undefined, 5), false);
  });

  test("matching tv passes through", () => {
    assert.equal(isTokenVersionRevoked(0, 0), false);
    assert.equal(isTokenVersionRevoked(3, 3), false);
  });

  test("token tv strictly less than DB tv ⇒ revoked", () => {
    // After revokeAllUserTokens(uid) the DB tv is bumped; any token with an
    // older tv must be rejected.
    assert.equal(isTokenVersionRevoked(0, 1), true);
    assert.equal(isTokenVersionRevoked(2, 5), true);
  });

  test("token tv greater than DB tv passes (DB is the floor)", () => {
    // Defensive: a stale read from the DB shouldn't reject a freshly issued
    // token whose tv is ahead of the cached row.
    assert.equal(isTokenVersionRevoked(5, 3), false);
  });

  test("nullish DB tv treated as 0", () => {
    assert.equal(isTokenVersionRevoked(0, undefined), false);
    assert.equal(isTokenVersionRevoked(1, undefined), false);
  });
});

// =============================================================================
// Expired-token denial via authMiddleware. We can exercise this without a
// DB because verifyToken() returns null on an expired JWT *before* the
// middleware reaches the token-version DB lookup.
// =============================================================================

describe("authMiddleware — expired token", () => {
  test("rejects an expired Bearer token with UNAUTHENTICATED + audit reason", async () => {
    // Build a token that is already expired. generateToken() uses the
    // module's JWT_SECRET so the signature itself is valid — only the
    // expiry will trip the verifier.
    // jsonwebtoken is a CJS module; dynamic import returns { default: { sign, verify, ... } }
    const jwtMod = await import("jsonwebtoken");
    const jwt = (jwtMod as unknown as { default: typeof jwtMod }).default ?? jwtMod;
    const secret = process.env["SESSION_SECRET"] ?? "mtos-dev-secret";
    const expired = jwt.sign(
      { id: 99, email: "expired@mtos.local", name: "Expired", role: "admin", tv: 0 },
      secret,
      { expiresIn: "-1s" },
    );
    const req = makeReq({ headers: { authorization: `Bearer ${expired}` } });
    const res = makeRes();
    const { nextCalled } = await runMiddleware(authMiddleware, req, res);
    assert.equal(nextCalled, false);
    assert.equal(res.statusCode, 401);
    const body = res.body as { code: string; message: string };
    assert.equal(body.code, "UNAUTHENTICATED");
    assert.match(body.message, /invalid or expired/i);
    // No req.user must be attached on the failure path.
    assert.equal((req as unknown as { user: unknown }).user, undefined);
  });

  test("freshly issued token is NOT rejected by signature/expiry checks", async () => {
    // We can't assert the middleware reaches `next()` without a DB (the
    // token-version row lookup runs after signature verification), but we
    // CAN assert the failure code is no longer the expired/invalid one
    // when the token is well-formed. The DB call will fail-closed with
    // either a 401 ("user_account_not_found") or 503 ("auth_unavailable")
    // — both acceptable; the contract here is "valid signature ⇒ NOT
    // invalid_or_expired_token".
    const fresh = generateToken({ id: 999, email: "fresh@mtos.local", name: "Fresh", role: "admin" });
    const req = makeReq({ headers: { authorization: `Bearer ${fresh}` } });
    const res = makeRes();
    await runMiddleware(authMiddleware, req, res);
    if (res.statusCode === 401) {
      const body = res.body as { message: string };
      assert.doesNotMatch(body.message, /invalid or expired/i);
    }
  });
});

// =============================================================================
// Cases viewer ownership — pure predicate. Mirrors GET /api/cases and
// GET /api/cases/:id semantics without spinning up the DB.
// =============================================================================

describe("isCaseVisibleToUser()", () => {
  const otherUser = { id: 7, role: "viewer" as const };
  const ownedRow = { created_by_user_id: 7, assigned_to: null };
  const assignedRow = { created_by_user_id: 99, assigned_to: 7 };
  const foreignRow = { created_by_user_id: 99, assigned_to: 42 };
  const orphanRow = { created_by_user_id: null, assigned_to: null };

  test("viewer sees rows they own", () => {
    assert.equal(isCaseVisibleToUser(otherUser, ownedRow), true);
  });
  test("viewer sees rows they are assigned to (but did not create)", () => {
    assert.equal(isCaseVisibleToUser(otherUser, assignedRow), true);
  });
  test("viewer cannot see rows they neither own nor are assigned to", () => {
    assert.equal(isCaseVisibleToUser(otherUser, foreignRow), false);
  });
  test("viewer cannot see orphan rows (both ownership cols null)", () => {
    assert.equal(isCaseVisibleToUser(otherUser, orphanRow), false);
  });

  for (const role of ["paralegal", "attorney", "admin"] as const) {
    test(`${role} sees every row regardless of ownership (no per-row scope)`, () => {
      const u = { id: 1, role };
      assert.equal(isCaseVisibleToUser(u, ownedRow), true);
      assert.equal(isCaseVisibleToUser(u, assignedRow), true);
      assert.equal(isCaseVisibleToUser(u, foreignRow), true);
      assert.equal(isCaseVisibleToUser(u, orphanRow), true);
    });
  }

  test("viewer with id=0 (dev synthetic) does not match orphan rows", () => {
    // Regression for the god-mode removal: id=0 must not magically own
    // rows whose nullable owner column happens to be null. The strict
    // equality on null guards against `0 === null` JS coercion bugs.
    const dev = { id: 0, role: "viewer" as const };
    assert.equal(isCaseVisibleToUser(dev, orphanRow), false);
  });
});

// =============================================================================
// Production-mode bypass prevention.
//
// `IS_DEV` in lib/rbac.ts is captured at module-import time, so we cannot
// flip it inside this process. Instead we spawn a child node that sets
// `NODE_ENV=production` BEFORE importing rbac, then asserts the
// authMiddleware refuses an unauthenticated request — i.e. no dev shim
// engages. This is the single most important regression for task #10:
// the previous bug was a dev bypass active under `NODE_ENV !== "production"`,
// which silently fired on staging, on test, and when the var was unset.
// =============================================================================

describe("production NODE_ENV refuses the dev-mode bypass", () => {
  test("authMiddleware denies unauthenticated requests under NODE_ENV=production", async () => {
    const { spawnSync } = await import("node:child_process");
    const path = await import("node:path");
    const apiServerRoot = path.resolve(import.meta.dirname, "../../..");

    // The child runs an inline tsx program: set NODE_ENV via env, import
    // rbac, exercise the middleware against a stub request/response, and
    // print a one-line JSON verdict on stdout.
    //
    // We cannot let the child touch the real DB, so the request is
    // unauthenticated (no Bearer header). In dev mode this is the path
    // that engages the synthetic admin user; in any non-dev env it must
    // emit 401 + UNAUTHENTICATED with no req.user attached.
    const program = `
      import("./src/lib/rbac.ts").then(async ({ authMiddleware }) => {
        const req = { headers: {}, path: "/x", method: "GET", socket: { remoteAddress: "127.0.0.1" }, get: () => undefined, ip: "127.0.0.1" };
        let status = 0; let body;
        const headers = {};
        const res = {
          status(n) { status = n; return this; },
          json(b) { body = b; return this; },
          setHeader(k, v) { headers[k.toLowerCase()] = v; },
          getHeader(k) { return headers[k.toLowerCase()]; },
        };
        await new Promise((resolve) => {
          const next = () => resolve();
          const r = authMiddleware(req, res, next);
          if (r && typeof r.then === "function") r.then(() => resolve());
          else if (status !== 0) resolve();
        });
        // eslint-disable-next-line no-console
        console.log(JSON.stringify({ status, code: body && body.code, hasUser: req.user !== undefined, role: req.user && req.user.role }));
      }).catch((e) => { console.error("CHILD_ERR:" + (e && e.message ? e.message : String(e))); process.exit(2); });
    `;
    const result = spawnSync(
      process.execPath,
      ["--import", "tsx", "-e", program],
      {
        cwd: apiServerRoot,
        env: {
          ...process.env,
          NODE_ENV: "production",
          // SESSION_SECRET is REQUIRED in non-dev — provide a stable test
          // value so the rbac module loads. The middleware behaviour we're
          // testing (refusing the bypass) is independent of the secret.
          SESSION_SECRET: process.env["SESSION_SECRET"] ?? "test-only-secret-not-real",
          RBAC_DISABLE_AUDIT: "1",
        },
        encoding: "utf-8",
        timeout: 30_000,
      },
    );
    if (result.status !== 0) {
      throw new Error(
        `child exited ${result.status}; stderr: ${result.stderr?.toString().slice(0, 500)}; stdout: ${result.stdout?.toString().slice(0, 500)}`,
      );
    }
    const lastLine = (result.stdout ?? "").trim().split(/\n/).filter(Boolean).pop() ?? "";
    let verdict: { status: number; code: string; hasUser: boolean; role?: string };
    try {
      verdict = JSON.parse(lastLine);
    } catch (_e) {
      throw new Error(`could not parse child verdict: ${lastLine}`);
    }
    assert.equal(verdict.status, 401, "production must return 401 for unauth request");
    assert.equal(verdict.code, "UNAUTHENTICATED");
    assert.equal(verdict.hasUser, false, "production must NOT attach a synthetic dev user");
    assert.equal(verdict.role, undefined);
  });
});
