// Disable audit writes before importing rbac.ts so audit module reads the
// flag at import time and skips pg inserts.
process.env["RBAC_DISABLE_AUDIT"] = "1";

import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { pool } from "@workspace/db";

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

// In-memory request/response stand-ins covering only the express bits the
// rbac middleware touches.
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
  // socket is read by the audit logger; stub it to avoid a throw when
  // there's no real connection.
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
    // Hook res.json so the deny path also resolves the promise.
    const origJson = res.json.bind(res);
    res.json = (b: unknown) => {
      const r = origJson(b);
      done();
      return r;
    };
    Promise.resolve(mw(req, res as unknown as express.Response, next)).then(() => {
      // Fallback if the mw exited without calling next() or res.json().
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

  test("attorney cannot reach admin-only newly migrated surfaces", () => {
    for (const p of [
      Permission.OCR_QUEUE_ADMIN,
      Permission.IMAGE_OBJECTS_DELETE,
      Permission.COMPLIANCE_VIEW,
      Permission.VENDORS_DELETE,
    ]) {
      assert.equal(ROLE_PERMISSIONS.attorney.has(p), false, `attorney must not have ${p}`);
    }
  });

  test("paralegal can perform read-tier work on newly migrated surfaces", () => {
    for (const p of [
      Permission.NEWS_VIEW,
      Permission.NPI_LOOKUP,
      Permission.TIMELINE_VIEW,
      Permission.DASHBOARD_VIEW,
      Permission.REVIEW_QUEUE_VIEW,
      Permission.IMAGE_OBJECTS_VIEW,
      Permission.OCR_VIEW,
      Permission.OCR_UPLOAD,
      Permission.OCR_AI_FIELDS,
      Permission.LEAD_IMPORT_PREVIEW,
      Permission.DRAFTING_TEMPLATES_VIEW,
      Permission.DRAFTING_GENERATE,
      Permission.DOCUMENTS_VIEW,
      Permission.DOCUMENTS_CREATE,
      Permission.DOCUMENTS_UPDATE,
      Permission.DOCUMENTS_REDACT,
      Permission.ANALYTICS_PREDICTIVE_LEAD_VIEW,
      // Read-only catalogues that were previously requireRole("viewer") and
      // therefore admitted paralegal via role hierarchy. The migration must
      // preserve that access — regression test.
      Permission.BUYERS_VIEW,
      Permission.LEAD_SOURCES_VIEW,
      Permission.TEMPLATES_VIEW,
      Permission.WORKFLOW_SETTINGS_VIEW,
      Permission.DOCUMENTS_VIEW,
      Permission.VENDORS_VIEW,
    ]) {
      assert.equal(ROLE_PERMISSIONS.paralegal.has(p), true, `paralegal should have ${p}`);
    }
  });

  test("paralegal cannot perform attorney-tier write actions on migrated surfaces", () => {
    for (const p of [
      Permission.LEAD_IMPORT_EXECUTE,
      Permission.REVIEW_QUEUE_RESOLVE,
      Permission.DOCUMENTS_DELETE,
      Permission.ANALYTICS_VIEW,
      Permission.DECISION_ENGINE_VIEW,
      Permission.PARALEGAL_VIEW,
      Permission.VENDORS_MANAGE,
      Permission.FORMS_CONFIG_VIEW,
    ]) {
      assert.equal(ROLE_PERMISSIONS.paralegal.has(p), false, `paralegal must not have ${p}`);
    }
  });

  test("viewer can browse but not act on newly migrated surfaces", () => {
    // Viewer-tier reads
    for (const p of [
      Permission.DASHBOARD_VIEW,
      Permission.NEWS_VIEW,
      Permission.DOCUMENTS_VIEW,
      Permission.BUYERS_VIEW,
      Permission.LEAD_SOURCES_VIEW,
      Permission.WORKFLOW_SETTINGS_VIEW,
      Permission.TEMPLATES_VIEW,
    ]) {
      assert.equal(ROLE_PERMISSIONS.viewer.has(p), true, `viewer should have ${p}`);
    }
    // But not any mutation/admin
    for (const p of [
      Permission.DOCUMENTS_CREATE,
      Permission.DOCUMENTS_UPDATE,
      Permission.DOCUMENTS_DELETE,
      Permission.BUYERS_MANAGE,
      Permission.LEAD_SOURCES_MANAGE,
      Permission.WORKFLOW_SETTINGS_MANAGE,
      Permission.TEMPLATES_MANAGE,
      Permission.NPI_LOOKUP,
      Permission.OCR_UPLOAD,
      Permission.LEAD_IMPORT_PREVIEW,
      Permission.REVIEW_QUEUE_VIEW,
      Permission.IMAGE_OBJECTS_VIEW,
      Permission.DECISION_ENGINE_VIEW,
      Permission.ANALYTICS_VIEW,
      Permission.PARALEGAL_VIEW,
      Permission.VENDORS_VIEW,
      Permission.FORMS_CONFIG_VIEW,
      Permission.TIMELINE_VIEW,
    ]) {
      assert.equal(ROLE_PERMISSIONS.viewer.has(p), false, `viewer must not have ${p}`);
    }
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

  // requireRole(min) → roles allowed (hierarchy-only).
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

  test("variadic: passes when role grants ANY one of the listed perms (any-of)", async () => {
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

// Dev-mode flag: strictly NODE_ENV === "development".

describe("dev gate (IS_DEV)", () => {
  test("the exported IS_DEV reflects the current NODE_ENV", () => {
    const expected = process.env["NODE_ENV"] === "development";
    assert.equal(__rbacInternal.isDev(), expected);
  });

  // IS_DEV is captured at import time, so re-execute the predicate in
  // isolation against problematic env shapes.
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
    // Casing/whitespace/aliases must not enable the bypass.
    for (const value of ["Development", "DEVELOPMENT", "development ", " development", "dev", "develop"]) {
      assert.equal(
        isDevPredicate(value),
        false,
        `expected dev predicate === false for NODE_ENV=${JSON.stringify(value)}`,
      );
    }
  });
});

// validateRouteTable: boot-time gate-presence regression.

describe("validateRouteTable (boot-time)", () => {
  test("rejects an authenticated route with no role/permission gate", async () => {
    const { validateRouteTable } = await import("../route-protection.js");
    const { labelRouter } = await import("../route-protection.js");
    const Router = (await import("express")).Router;

    const parent = Router();
    const child = labelRouter(Router(), "test-bad");
    child.use(authMiddleware);
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
    const { validateRouteTable, labelRouter } = await import("../route-protection.js");
    const Router = (await import("express")).Router;

    const parent = Router();
    const child = labelRouter(Router(), "test-fakepub");
    // Old well-known key from the previous Symbol.for() implementation.
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

  test("path-scoped middleware does NOT authorize sibling paths in the same router", async () => {
    const { validateRouteTable, labelRouter } = await import("../route-protection.js");
    const Router = (await import("express")).Router;

    const parent = Router();
    const child = labelRouter(Router(), "scoped-test");
    child.use(authMiddleware);
    child.use("/admin", requireRole("admin"));
    child.get("/admin/users", (_req, res) => res.json({ ok: true }));
    child.get("/public", (_req, res) => res.json({ ok: true }));
    parent.use("/scoped-test", child);

    assert.throws(
      () => validateRouteTable(parent),
      /scoped-test.*GET \/public.*no requireRole/s,
      "GET /public must fail validation because /admin-scoped requireRole does not cover it",
    );
  });

  test("path-scoped middleware DOES authorize sibling paths whose path matches", async () => {
    const { validateRouteTable, labelRouter } = await import("../route-protection.js");
    const Router = (await import("express")).Router;

    const parent = Router();
    const child = labelRouter(Router(), "scoped-positive");
    child.use(authMiddleware);
    child.use("/admin", requireRole("admin"));
    child.get("/admin/users", (_req, res) => res.json({ ok: true }));
    child.get("/admin/audit", (_req, res) => res.json({ ok: true }));
    parent.use("/scoped-positive", child);

    const result = validateRouteTable(parent);
    assert.equal(result.checked, 2);
    assert.equal(result.protected, 2);
    for (const entry of result.policy) {
      assert.equal(entry.status, "role-gated");
      assert.deepEqual(entry.requiredRoles, ["admin"]);
    }
  });
});

// Token revocation — pure helper boundaries (no DB).

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
    assert.equal(isTokenVersionRevoked(0, 1), true);
    assert.equal(isTokenVersionRevoked(2, 5), true);
  });

  test("token tv greater than DB tv passes (DB is the floor)", () => {
    assert.equal(isTokenVersionRevoked(5, 3), false);
  });

  test("nullish DB tv treated as 0", () => {
    assert.equal(isTokenVersionRevoked(0, undefined), false);
    assert.equal(isTokenVersionRevoked(1, undefined), false);
  });
});

// authMiddleware: expired-token rejection (no DB needed — verifyToken
// returns null on expiry before the token-version lookup).

describe("authMiddleware — expired token", () => {
  test("rejects an expired Bearer token with UNAUTHENTICATED + audit reason", async () => {
    // jsonwebtoken is CJS; dynamic import returns { default: { sign, verify } }.
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
    assert.equal((req as unknown as { user: unknown }).user, undefined);
  });

  test("freshly issued token is NOT rejected by signature/expiry checks", async () => {
    // Without a DB the token-version lookup fails closed, but the message
    // must not be invalid_or_expired_token for a well-formed signature.
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

// Case visibility predicate — mirrors /api/cases without the DB.

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

// IS_DEV is captured at import time, so spawn a child with NODE_ENV=production
// to verify the dev-shim is not engaged outside development.

describe("production NODE_ENV refuses the dev-mode bypass", () => {
  test("authMiddleware denies unauthenticated requests under NODE_ENV=production", async () => {
    const { spawnSync } = await import("node:child_process");
    const path = await import("node:path");
    const apiServerRoot = path.resolve(import.meta.dirname, "../../..");

    // Inline tsx program: set NODE_ENV=production, import rbac, run the
    // middleware against a stub req/res, print a one-line JSON verdict.
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
          // SESSION_SECRET is required in non-dev so the module loads.
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
