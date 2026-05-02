// Booted-app role × route access matrix: real express app on an ephemeral
// port, JWT per role, asserts HTTP outcome across every trust boundary.

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import type { AddressInfo } from "node:net";
import type { Express, Router } from "express";
import { db, pool, usersTable } from "@workspace/db";
import { sql } from "drizzle-orm";
import { generateToken, type UserRole } from "../rbac.js";
import {
  validateRouteTable,
  type RoutePolicyEntry,
} from "../route-protection.js";
import {
  backfillCaseOwnership,
  ensureSystemUser,
  inferOwnerFromAuditLog,
} from "../case-ownership-backfill.js";

// Audit writes off — rbac.test.ts covers the denial+audit-row path.
process.env["RBAC_DISABLE_AUDIT"] = "1";
// Subscription gate off — these tests assert role/permission gating, not
// billing posture. The gate has its own dedicated coverage path. Without
// this, every PUT/POST in the matrix would trip the 402 NO_FIRM branch
// because the ephemeral test users aren't members of any firm.
process.env["MTOS_DISABLE_BILLING_GATE"] = "1";

// Typed helpers (no `as any`).

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

// Boot the app + capture validateRouteTable's policy report.

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
      INSERT INTO mtos_users (email, name, role, password_hash, token_version, firm_id)
      VALUES (${email}, ${`Matrix ${role}`}, ${role}, ${"$2b$10$test.placeholder.hash.not.usable"}, 0, 1)
      RETURNING id
    `);
    const id = queryRows<{ id: number }>(inserted)[0]?.id;
    if (typeof id !== "number") throw new Error(`failed to insert ${role}`);
    const token = generateToken({ id, email, name: `Matrix ${role}`, role, firm_id: 1 });
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

// 1. Public allowlist enforcement (asserts against validateRouteTable's policy).

describe("public allowlist (validateRouteTable policy)", () => {
  test("only health / forms-public / web-forms / webhooks routers are stamped 'public'", () => {
    if (!booted) throw new Error("app not booted");
    const publicRouters = new Set(
      booted.policy
        .filter((p) => p.status === "public")
        .map((p) => p.router),
    );
    const expected = new Set(["health", "forms-public", "web-forms", "webhooks", "vapi-tools", "spa"]);
    for (const r of publicRouters) {
      assert.ok(expected.has(r), `unexpected public router: ${r}`);
    }
    assert.ok(publicRouters.size > 0, "expected at least one public router in policy");
  });

  test("auth router exceptions are exactly login / refresh / register / verify-email / invite-info", () => {
    if (!booted) throw new Error("app not booted");
    const exceptions = booted.policy
      .filter((p) => p.status === "auth-exception")
      .map((p) => `${p.method} ${p.path}`)
      .sort();
    // GET /verify-email is the link-consumption endpoint added by Task #56.
    // The user has no session yet — registration deliberately does not
    // issue tokens — so this route must be reachable without a Bearer
    // header. The single-use SHA-256-hashed token in the query string
    // is the credential.
    //
    // GET /invite-info is the firm-invite prefill lookup added by Task
    // #57. Same shape as verify-email: no session yet, the SHA-256
    // hashed token in the query string is the credential, and the
    // response carries no token / hash material — only firm name and
    // optional email prefill so the /register page can render context.
    assert.deepEqual(exceptions, [
      "GET /invite-info",
      "GET /verify-email",
      "POST /login",
      "POST /refresh",
      "POST /register",
    ]);
  });

  test("EVERY non-public route is either auth-only or role-gated (no unprotected leaks)", () => {
    if (!booted) throw new Error("app not booted");
    for (const p of booted.policy) {
      assert.ok(
        ["public", "auth-exception", "auth-only", "role-gated"].includes(p.status),
        `route ${p.method} ${p.path} has unknown status ${p.status}`,
      );
    }
    // Cross-check the auth-only allowlist against the policy report.
    const authOnly = booted.policy.filter((p) => p.status === "auth-only").map((p) => `${p.router} ${p.method} ${p.path}`).sort();
    const expectedAuthOnly = [
      "auth GET /me",
      "auth POST /change-password",
      "auth POST /logout",
      "auth POST /mfa/disable",
      "auth POST /mfa/setup",
      "auth POST /mfa/verify",
      "billing GET /firm-status",
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

// 2. Public endpoints reachable without auth (path-prefix contract).

describe("public endpoints reachable unauthenticated (path-prefix contract)", () => {
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
    // Post-remount of formsPublicRouter to /api/forms-public, the old
    // /api/forms/preview/* path must now hit authMiddleware.
    const r = await probe("GET", "/api/forms/preview/some-tort");
    assert.equal(r.status, 401, `expected 401 on old public path, got ${r.status}`);
    assert.equal((r.body as { code?: string }).code, "UNAUTHENTICATED");
  });

  // Regression for the form-engine.tsx preview iframe: it must hit
  // /api/forms-public/preview/:tortId, NOT /api/forms/preview/:tortId. The
  // CRM page used the wrong path and the iframe rendered the API's
  // not_found JSON. This pair of assertions locks in (a) the correct public
  // path serves preview HTML, and (b) the wrong (auth-gated) path does NOT
  // serve preview content — so a future "fix" cannot silently re-mount the
  // preview under /api/forms without also tripping the path-prefix contract
  // test above.
  test("GET /api/forms-public/preview/paraquat returns 200 with the preview HTML shell", async () => {
    if (!booted) throw new Error("app not booted");
    // No Authorization header — public route must serve unauthenticated.
    const res = await fetch(`${booted.baseUrl}/api/forms-public/preview/paraquat`);
    assert.equal(res.status, 200, `expected 200, got ${res.status}`);
    const ct = res.headers.get("content-type") ?? "";
    assert.ok(ct.includes("text/html"), `expected HTML content-type, got ${ct}`);
    const html = await res.text();
    // Shell markers from forms-public.ts: preview-mode banner + the embed
    // script tag for the requested tort. Asserting both ensures we got the
    // actual preview shell rather than e.g. a generic 404 HTML page.
    assert.ok(html.includes("Preview Mode"), "preview HTML missing 'Preview Mode' banner");
    // Embed + preview-blocker scripts MUST point at the public router; if
    // they regress to /api/forms/* (auth-gated) the iframe loads in dev via
    // the synthetic-admin bypass but breaks in production with a 401.
    assert.ok(
      html.includes("/api/forms-public/embed/paraquat"),
      "preview HTML missing public embed script tag for paraquat",
    );
    assert.ok(
      html.includes("/api/forms-public/preview-blocker.js"),
      "preview HTML missing public preview-blocker script tag",
    );
    assert.ok(
      !html.includes("/api/forms/embed/") && !html.includes("/api/forms/preview-blocker.js"),
      "preview HTML must NOT reference auth-gated /api/forms/* script paths",
    );
  });

  test("GET /api/forms/preview/paraquat does NOT serve preview HTML (must be 401 or 404)", async () => {
    // The auth-gated /api/forms/* router intentionally has no /preview/:tortId
    // route (see routes/forms.ts L241-242). Unauthenticated → 401 from
    // authMiddleware; authenticated (or dev bypass) → 404 from the API
    // not-found handler. Either is fine — what we forbid is a 200 leaking
    // preview HTML through a re-added handler.
    const r = await probe("GET", "/api/forms/preview/paraquat");
    assert.notEqual(
      r.status,
      200,
      `auth-gated /api/forms/preview/:tortId must not serve preview HTML; got 200`,
    );
    assert.ok(
      r.status === 401 || r.status === 404,
      `expected 401 or 404 on intentionally-unsupported path, got ${r.status}`,
    );
  });

  // Regression for the form-engine.tsx Copy-Embed button: it must write a
  // <script src="…/api/forms-public/embed/<id>"> snippet to the clipboard,
  // NOT "/api/forms/embed/<id>". External sites that paste the snippet have
  // no auth cookie, so a snippet pointing at the auth-gated /api/forms/*
  // router 401s in production (404 in dev with bypass). This pair of
  // assertions locks in (a) the public embed path serves the JS unauth, and
  // (b) the auth-gated path does NOT serve embed JS — so a future "fix"
  // cannot silently re-mount the embed handler under /api/forms.
  test("GET /api/forms-public/embed/paraquat returns 200 with the embed JavaScript (no auth)", async () => {
    if (!booted) throw new Error("app not booted");
    // No Authorization header — public route must serve unauthenticated.
    const res = await fetch(`${booted.baseUrl}/api/forms-public/embed/paraquat`);
    assert.equal(res.status, 200, `expected 200, got ${res.status}`);
    const ct = res.headers.get("content-type") ?? "";
    assert.ok(
      ct.includes("application/javascript"),
      `expected application/javascript content-type, got ${ct}`,
    );
    const body = await res.text();
    // Markers from generateEmbedScript() in routes/forms.ts: the IIFE
    // header `(function(){` plus the API base var `var API="…/api/forms";`
    // plus the requested tort id literal. Asserting all three ensures we
    // got the actual embed payload rather than e.g. a generic 404 HTML
    // page or a different tort's script.
    assert.ok(body.startsWith("(function(){"), "embed JS missing IIFE header");
    assert.ok(body.includes('var API='), "embed JS missing API base declaration");
    assert.ok(body.includes('TORT_ID="paraquat"'), "embed JS missing paraquat tort id");
  });

  test("GET /api/forms/embed/paraquat does NOT serve embed JavaScript (must be 401 or 404)", async () => {
    // The auth-gated /api/forms/* router intentionally has no /embed/:tortId
    // route (see routes/forms.ts L241-243). Unauthenticated → 401 from
    // authMiddleware; authenticated (or dev bypass) → 404 from the API
    // not-found handler. Either is fine — what we forbid is a 200 leaking
    // the embed payload through a re-added handler that would silently
    // bypass the public router's CORS / cache-control / rate-limit posture.
    const r = await probe("GET", "/api/forms/embed/paraquat");
    assert.notEqual(
      r.status,
      200,
      `auth-gated /api/forms/embed/:tortId must not serve embed JavaScript; got 200`,
    );
    assert.ok(
      r.status === 401 || r.status === 404,
      `expected 401 or 404 on intentionally-unsupported path, got ${r.status}`,
    );
  });

  test("public path-prefix contract: every 'public' policy entry resolves under /api/healthz, /api/forms-public/, /api/web-forms/, /api/webhooks/, /api/vapi-tools/, or the SPA fallback (non-/api GETs)", () => {
    if (!booted) throw new Error("app not booted");
    // router-label → mounted URL prefix (mirror of routes/index.ts).
    const ROUTER_PREFIX: Record<string, string> = {
      health: "/api",
      "forms-public": "/api/forms-public",
      "web-forms": "/api/web-forms",
      webhooks: "/api/webhooks",
      "vapi-tools": "/api/vapi-tools",
      // SPA fallback: serves the React shell (index.html) for any non-/api GET
      // when the CRM static bundle is present. No PII, no auth required.
      spa: "",
    };
    const ALLOWED_PUBLIC_PREFIXES = [
      "/api/healthz",
      "/api/forms-public/",
      "/api/web-forms/",
      "/api/webhooks/",
      "/api/vapi-tools/",
    ];
    for (const p of booted.policy) {
      if (p.status !== "public") continue;
      // SPA fallback is a regex route (`^(?!/api/).*`); the validator records
      // its `path` as the regex source. Whitelist by router label since the
      // path is not a literal prefix.
      if (p.router === "spa") continue;
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

// 3. Protected endpoints deny unauthenticated requests.

describe("protected endpoints deny unauthenticated requests", () => {
  for (const path of ["/api/leads", "/api/cases", "/api/forms/config", "/api/decision-engine/portfolio"]) {
    test(`GET ${path} ⇒ 401 UNAUTHENTICATED without a token`, async () => {
      const r = await probe("GET", path);
      assert.equal(r.status, 401);
      assert.equal((r.body as { code?: string }).code, "UNAUTHENTICATED");
    });
  }
});

// 4. Role × route allow/deny matrix.

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
      INSERT INTO mtos_users (email, name, role, password_hash, token_version, firm_id)
      VALUES (${email}, ${"Revocation Probe"}, ${"attorney"}, ${"$2b$10$test.placeholder.hash.not.usable"}, 0, 1)
      RETURNING id
    `);
    const id = queryRows<{ id: number }>(inserted)[0]?.id;
    if (typeof id !== "number") throw new Error("failed to insert revocation probe user");

    try {
      const token = generateToken({ id, email, name: "Revocation Probe", role: "attorney", firm_id: 1 });

      // Pre-bump: token works.
      const before = await probe("GET", "/api/auth/me", { token });
      assert.equal(before.status, 200, `pre-bump GET /api/auth/me must be 200, got ${before.status} (${JSON.stringify(before.body).slice(0, 200)})`);

      // Bump token_version (mirrors logout-all / password-reset / MFA enrol).
      await db.execute(sql`UPDATE mtos_users SET token_version = token_version + 1 WHERE id = ${id}`);

      const after = await probe("GET", "/api/auth/me", { token });
      assert.equal(after.status, 401, `post-bump GET /api/auth/me must be 401, got ${after.status} (${JSON.stringify(after.body).slice(0, 200)})`);
      const code = (after.body as { code?: string }).code;
      assert.ok(
        code === "TOKEN_REVOKED" || code === "UNAUTHENTICATED",
        `expected code TOKEN_REVOKED or UNAUTHENTICATED, got ${String(code)}`,
      );

      // Second identical request must remain rejected.
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

// 7. Cases ownership backfill smoke test (Task #22).
// Proves the historical-row remediation works end-to-end:
//   1. A case with NULL `created_by_user_id` (the legacy state every
//      pre-Task-#22 row was in) is invisible to viewers.
//   2. After running `backfillCaseOwnership()`, the case is owned by
//      the user recorded in the earliest audit-log entry (audit-log
//      inference path) and the same viewer's GET /api/cases now lists it.
// Restores the NOT NULL constraint at the end so it does not leak into
// later test runs.

describe("cases ownership backfill smoke test (Task #22)", () => {
  test("legacy NULL-owner case becomes visible to its viewer after backfillCaseOwnership() recovers the owner from audit_log", async () => {
    const viewer = ephemeralUsers.find((u) => u.role === "viewer");
    if (!viewer) throw new Error("ephemeral viewer not initialised");

    const legacyId = crypto.randomUUID();
    let nullableDropped = false;
    try {
      // Drop NOT NULL so we can simulate the pre-backfill state. Wrapped
      // in a try/finally below so a thrown assertion still re-applies it.
      await db.execute(sql`ALTER TABLE cases ALTER COLUMN created_by_user_id DROP NOT NULL`);
      nullableDropped = true;

      // Insert the "legacy" row with NULL ownership — exactly the shape
      // every pre-Task-#22 row was in.
      await db.execute(sql`
        INSERT INTO cases (id, data, status, created_by_user_id, assigned_to)
        VALUES (${legacyId}, ${"{}"}::jsonb, ${"open"}, NULL, NULL)
      `);

      // Pre-backfill: viewer must NOT see the row (the OR-eq filter on
      // a NULL column returns no rows for any positive user id).
      const before = await probe("GET", "/api/cases", { token: viewer.token });
      assert.equal(before.status, 200, `pre-backfill viewer GET /api/cases must be 200, got ${before.status}`);
      const beforeIds = ((before.body as Array<{ id: string }>) ?? []).map((r) => r.id);
      assert.ok(
        !beforeIds.includes(legacyId),
        `pre-backfill viewer must NOT see legacy NULL-owner case ${legacyId} — leaked: ${JSON.stringify(beforeIds)}`,
      );

      // Seed an audit_log row that records the viewer as the original
      // creator. The backfill walks the earliest audit row per case and
      // pulls `details.created_by_user_id` if present and points at a
      // real user — exactly the shape `routes/cases.ts` writes today.
      await db.execute(sql`
        INSERT INTO audit_log (entity_type, entity_id, action, details, occurred_at)
        VALUES (
          ${"case"},
          ${legacyId},
          ${"intake_submitted"},
          ${JSON.stringify({ created_by_user_id: viewer.id, data: {} })}::jsonb,
          NOW() - INTERVAL '1 day'
        )
      `);

      // The unit-level inference function should pick up the viewer.
      const inferred = await inferOwnerFromAuditLog(legacyId);
      assert.equal(
        inferred,
        viewer.id,
        `inferOwnerFromAuditLog must recover viewer.id (${viewer.id}) from the seeded audit row, got ${String(inferred)}`,
      );

      // Run the backfill. It must scan our row, infer owner=viewer.id
      // from the audit log, and write the update.
      const result = await backfillCaseOwnership();
      assert.ok(
        result.scanned >= 1,
        `backfillCaseOwnership must scan at least 1 row, got ${result.scanned}`,
      );
      assert.ok(
        result.inferredFromAudit >= 1,
        `backfillCaseOwnership must infer at least 1 row from audit log, got ${result.inferredFromAudit}`,
      );

      // DB-level check: the row's owner is now the viewer.
      const ownerCheck = await db.execute(sql`
        SELECT created_by_user_id FROM cases WHERE id = ${legacyId}
      `);
      const ownerRow = queryRows<{ created_by_user_id: number | null }>(ownerCheck)[0];
      assert.equal(
        ownerRow?.created_by_user_id,
        viewer.id,
        `post-backfill case ${legacyId} must be owned by viewer ${viewer.id}, got ${String(ownerRow?.created_by_user_id)}`,
      );

      // HTTP smoke: viewer GET /api/cases now lists the row.
      const after = await probe("GET", "/api/cases", { token: viewer.token });
      assert.equal(after.status, 200, `post-backfill viewer GET /api/cases must be 200, got ${after.status}`);
      const afterIds = ((after.body as Array<{ id: string }>) ?? []).map((r) => r.id);
      assert.ok(
        afterIds.includes(legacyId),
        `post-backfill viewer must see backfilled case ${legacyId} in list, got ${JSON.stringify(afterIds)}`,
      );

      // GET /:id round-trip — also 200.
      const single = await probe("GET", `/api/cases/${legacyId}`, { token: viewer.token });
      assert.equal(single.status, 200, `post-backfill viewer GET /api/cases/${legacyId} must be 200, got ${single.status}`);
    } finally {
      // Cleanup in reverse order: row → audit row → restore NOT NULL.
      await db.execute(sql`DELETE FROM cases WHERE id = ${legacyId}`).catch(() => {});
      await db.execute(sql`DELETE FROM audit_log WHERE entity_type = ${"case"} AND entity_id = ${legacyId}`).catch(() => {});
      if (nullableDropped) {
        await db.execute(sql`ALTER TABLE cases ALTER COLUMN created_by_user_id SET NOT NULL`).catch(() => {});
      }
    }
  });

  // Pin both defenses against a system-email hijack:
  //   (1) /api/auth/register rejects the reserved email with 409.
  //   (2) ensureSystemUser refuses any existing row at that email
  //       whose role is not admin.
  test("public registration cannot hijack the system backfill email; ensureSystemUser refuses non-admin row", async () => {
    // Make sure no system user row exists at the start so we can place a
    // poisoned one. Save the prior id (and any cases already owned by it)
    // so we can restore them in finally.
    const prior = await db.execute(sql`SELECT id FROM mtos_users WHERE email = 'system@mtos.local'`);
    const priorRow = queryRows<{ id: number }>(prior)[0];
    let priorReassigned: Array<{ id: string }> = [];
    let placedPoisonRow = false;
    let poisonRowId: number | null = null;
    try {
      if (priorRow) {
        // Park any cases pointing at the real system user under the
        // poison row will fail FK if we try to delete it directly.
        // Instead, drop NOT NULL momentarily, null them out, restore
        // later. (audit_log has no FK on user id so we can leave it.)
        await db.execute(sql`ALTER TABLE cases ALTER COLUMN created_by_user_id DROP NOT NULL`);
        const owned = await db.execute(sql`SELECT id FROM cases WHERE created_by_user_id = ${priorRow.id}`);
        priorReassigned = queryRows<{ id: string }>(owned);
        if (priorReassigned.length > 0) {
          await db.execute(sql`UPDATE cases SET created_by_user_id = NULL WHERE created_by_user_id = ${priorRow.id}`);
        }
        await db.execute(sql`DELETE FROM mtos_users WHERE id = ${priorRow.id}`);
      }

      // Defense (1): /api/auth/register must reject the reserved email.
      const regResp = await probe("POST", "/api/auth/register", {
        body: {
          email: "system@mtos.local",
          password: "Sup3r$ecret!Pa$$w0rd-attempt-1",
          name: "Attacker",
        },
      });
      assert.equal(
        regResp.status,
        409,
        `register MUST reject reserved system@mtos.local with 409 (duplicate-email parity), got ${regResp.status} (body: ${JSON.stringify(regResp.body)})`,
      );
      // ...and not because a row actually exists yet — confirm none was created.
      const afterRegister = await db.execute(sql`SELECT id FROM mtos_users WHERE email = 'system@mtos.local'`);
      assert.equal(
        queryRows(afterRegister).length,
        0,
        "register handler must not create a row when the reserved-email guard rejects",
      );

      // Defense (2): manually plant a poisoned viewer row at the reserved
      // email (simulating an attacker who bypassed the register guard via
      // some other write path) and prove ensureSystemUser refuses to
      // trust it.
      const poison = await db
        .insert(usersTable)
        .values({
          email: "system@mtos.local",
          name: "Poisoned",
          role: "viewer",
          // Properly-formatted hash so we exercise the role check, not
          // the verifyPassword path.
          password_hash:
            "abcdef0123456789abcdef0123456789:" + "0".repeat(128),
          firm_id: 1,
        })
        .returning({ id: usersTable.id });
      poisonRowId = poison[0]?.id ?? null;
      placedPoisonRow = true;

      let threw = false;
      try {
        await ensureSystemUser();
      } catch (err) {
        threw = true;
        assert.match(
          (err as Error).message,
          /role=viewer/,
          `ensureSystemUser must mention the rejected role in its error, got: ${(err as Error).message}`,
        );
      }
      assert.equal(
        threw,
        true,
        "ensureSystemUser MUST throw when the existing row at the reserved email is non-admin",
      );

      // And the poisoned row must NOT have inherited ownership of any
      // case (the backfill should not even have been allowed to run).
      if (poisonRowId !== null) {
        const owned = await db.execute(
          sql`SELECT id FROM cases WHERE created_by_user_id = ${poisonRowId}`,
        );
        assert.equal(
          queryRows(owned).length,
          0,
          "poisoned viewer row must not own any cases after the failed ensureSystemUser",
        );
      }
    } finally {
      // Tear the poison row down.
      if (placedPoisonRow && poisonRowId !== null) {
        await db.execute(sql`DELETE FROM mtos_users WHERE id = ${poisonRowId}`).catch(() => {});
      }
      // Re-create a real system user via the now-clean path so the
      // earlier smoke test's invariants (NOT NULL on created_by_user_id)
      // remain satisfied.
      const restoredId = await ensureSystemUser();
      // Re-attach any previously orphaned cases to the restored system user.
      if (priorReassigned.length > 0) {
        for (const r of priorReassigned) {
          await db
            .execute(sql`UPDATE cases SET created_by_user_id = ${restoredId} WHERE id = ${r.id}`)
            .catch(() => {});
        }
      }
      // Restore NOT NULL if we dropped it.
      if (priorRow) {
        await db
          .execute(sql`ALTER TABLE cases ALTER COLUMN created_by_user_id SET NOT NULL`)
          .catch(() => {});
      }
    }
  });

  // Pin both legs of the login-DoS fix: ensureSystemUser stores a valid
  // salt:hash, and verifyPassword fails closed on malformed input. A
  // login as system@mtos.local must always cleanly 401, never 5xx.
  test("login attempt as the system backfill user returns 401 (no crash from malformed hash)", async () => {
    // Make sure the system user actually exists before we probe login;
    // otherwise we'd just be testing the "unknown email" path which
    // returns 401 unconditionally and would mask any real regression.
    await ensureSystemUser();

    const resp = await probe("POST", "/api/auth/login", {
      body: { email: "system@mtos.local", password: "obviously-wrong-password-1!" },
    });

    assert.equal(
      resp.status,
      401,
      `login as system user must return 401, got ${resp.status} (body: ${JSON.stringify(resp.body)}). ` +
        `If this is 500 the password_hash format is wrong and verifyPassword crashed.`,
    );
  });
});

// 9. Real login + MFA smoke test (Task #51 T005, blocker #20).
// Architect feedback: the prior #20 changes only verified the dev-bypass
// gate's env behavior. We also need a real, end-to-end exercise of the
// production-style auth path: register → login → MFA setup → TOTP code →
// MFA verify → second login that demands the TOTP code → success. This
// proves the seams the dev-bypass would normally short-circuit (TOTP
// secret encryption round-trip, mfa_enabled state machine, and the
// totp_code field in LoginBody) are actually wired together.
describe("real login + MFA smoke test (Task #51 T005, blocker #20)", () => {
  test("register → login → mfa setup → verify → mfa-required login → totp login", async () => {
    const { generateTOTP } = await import("../totp.js");

    const email = `mfa-smoke-${TS}-${crypto.randomBytes(4).toString("hex")}@mtos.test`;
    const password = "MfaSmoke!Pw-2026";
    const cleanupIds: number[] = [];

    try {
      // 1. Register a fresh user — public registration always lands as
      // viewer. As of Task #56 register returns 202 + pending_verification
      // and does NOT issue a JWT pair; the user is persisted with
      // email_verified_at = NULL until the verification link is consumed.
      const reg = await probe("POST", "/api/auth/register", {
        body: { email, password, name: "MFA Smoke" },
      });
      assert.equal(
        reg.status,
        202,
        `register must succeed (pending_verification), got ${reg.status} (${JSON.stringify(reg.body)})`,
      );
      const regBody = reg.body as { status?: string; token?: unknown };
      assert.equal(regBody.status, "pending_verification");
      assert.equal(regBody.token, undefined, "register must NOT return a token before verification");

      // The verification email is async; this smoke test does not exercise
      // the link-consumption endpoint (auth-verify-email-route.test.ts owns
      // that contract). Mark the row verified directly so the rest of the
      // login → MFA flow can proceed without a real inbox.
      const userRows = await db.execute(
        sql`UPDATE mtos_users SET email_verified_at = NOW(), email_verification_token_hash = NULL, email_verification_token_expires_at = NULL WHERE email = ${email} RETURNING id, role`,
      );
      const userRow = (
        userRows as unknown as { rows?: Array<{ id: number; role: string }> }
      ).rows?.[0];
      assert.ok(userRow, "register must persist a user row even without issuing a token");
      assert.equal(userRow!.role, "viewer", "public registration must assign viewer role");
      cleanupIds.push(userRow!.id);

      // 2. Real /login (now that the row is verified): password path
      // returns a token. Without the verified flag the server would 403
      // with code=email_unverified — exactly the new gate this task adds.
      const login1 = await probe("POST", "/api/auth/login", { body: { email, password } });
      assert.equal(login1.status, 200, `login must succeed, got ${login1.status} (${JSON.stringify(login1.body)})`);
      const login1Body = login1.body as { token?: string; mfa_required?: boolean };
      assert.ok(login1Body.token, "login (pre-MFA) must return an access token");
      assert.notEqual(login1Body.mfa_required, true, "MFA must not be required before setup");
      const token = login1Body.token!;

      // 3. /mfa/setup returns the base32 secret + otpauth URL.
      const setup = await probe("POST", "/api/auth/mfa/setup", { token, body: {} });
      assert.equal(setup.status, 200, `mfa/setup must succeed, got ${setup.status} (${JSON.stringify(setup.body)})`);
      const setupBody = setup.body as { secret?: string; otpauth_url?: string };
      assert.ok(setupBody.secret && /^[A-Z2-7]+$/.test(setupBody.secret), "mfa/setup must return base32 secret");
      assert.ok(setupBody.otpauth_url?.startsWith("otpauth://totp/"), "mfa/setup must return otpauth URL");

      // 4. Generate a real TOTP code from the secret.
      const code = generateTOTP(setupBody.secret!);
      assert.match(code, /^\d{6}$/, "generateTOTP must produce 6 digits");

      // 5. /mfa/verify with the live code activates MFA.
      const verify = await probe("POST", "/api/auth/mfa/verify", { token, body: { totp_code: code } });
      assert.equal(verify.status, 200, `mfa/verify must succeed, got ${verify.status} (${JSON.stringify(verify.body)})`);
      const verifyBody = verify.body as { mfa_enabled?: boolean };
      assert.equal(verifyBody.mfa_enabled, true, "mfa/verify must report mfa_enabled=true");

      // 6. Second login WITHOUT a code must short-circuit at mfa_required.
      const login2 = await probe("POST", "/api/auth/login", { body: { email, password } });
      assert.equal(login2.status, 200, `login (no totp) must return 200 + mfa_required, got ${login2.status}`);
      const login2Body = login2.body as { mfa_required?: boolean; token?: string };
      assert.equal(login2Body.mfa_required, true, "post-MFA login without totp_code must report mfa_required");
      assert.equal(login2Body.token, undefined, "post-MFA login without totp_code MUST NOT return a token");

      // 7. Second login WITH a fresh totp_code passes and returns a token.
      const code2 = generateTOTP(setupBody.secret!);
      const login3 = await probe("POST", "/api/auth/login", {
        body: { email, password, totp_code: code2 },
      });
      assert.equal(login3.status, 200, `login (with totp) must succeed, got ${login3.status} (${JSON.stringify(login3.body)})`);
      const login3Body = login3.body as { token?: string };
      assert.ok(login3Body.token, "login with valid totp must return a token");
    } finally {
      // Clean up the ephemeral user so re-runs don't 409 on register.
      for (const id of cleanupIds) {
        await db.execute(sql`DELETE FROM mtos_users WHERE id = ${id}`);
      }
    }
  });
});

// Reference unused imports to keep linters happy — usersTable is consumed
// by the schema graph but not directly here.
void usersTable;
