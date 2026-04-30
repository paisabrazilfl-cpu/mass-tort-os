// Focused unit tests for lib/firm-context.ts.
//
// Three fail-close paths are required to (a) return 401 with the right
// error message and (b) write an audit_log row with the matching reason.
// We exercise the middleware directly with stub req/res objects — no
// HTTP layer required — because the middleware is mounted globally in
// routes/index.ts and is otherwise covered transitively by the route
// matrix test. The audit side effect is asserted with a real DB row
// query so we catch any silent fire-and-forget failure.

import { test, describe, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import type { Request, Response, NextFunction } from "express";
import { db, auditLogTable } from "@workspace/db";
import { sql } from "drizzle-orm";

// audit.ts gates writes on RBAC_DISABLE_AUDIT — must be unset before
// importing the middleware module so the audit insert path is live.
delete process.env["RBAC_DISABLE_AUDIT"];

import { firmContextMiddleware } from "../firm-context.js";

interface FakeRes {
  statusCode: number;
  body: unknown;
  ended: boolean;
  status: (n: number) => FakeRes;
  json: (b: unknown) => FakeRes;
}

function makeRes(): FakeRes {
  const res: FakeRes = {
    statusCode: 0,
    body: undefined,
    ended: false,
    status(n) {
      this.statusCode = n;
      return this;
    },
    json(b) {
      this.body = b;
      this.ended = true;
      return this;
    },
  };
  return res;
}

function makeReq(over: Partial<Request> = {}): Request {
  return {
    path: "/leads",
    method: "GET",
    headers: {},
    socket: { remoteAddress: "127.0.0.1" } as unknown as Request["socket"],
    ...over,
  } as unknown as Request;
}

async function runMw(req: Request, res: FakeRes): Promise<{ nextCalled: boolean }> {
  let nextCalled = false;
  const next: NextFunction = () => {
    nextCalled = true;
  };
  await firmContextMiddleware(req, res as unknown as Response, next);
  return { nextCalled };
}

async function readLatestDenial(reason: string): Promise<{ details: Record<string, unknown> } | null> {
  // audit.ts writes are awaited but our middleware uses fire-and-forget
  // (.catch). Poll briefly to give the insert time to land.
  for (let i = 0; i < 20; i++) {
    const rows = await db.execute(sql`
      SELECT details FROM audit_log
      WHERE entity_type = 'access_denied' AND action = ${reason}
      ORDER BY id DESC LIMIT 1
    `);
    const r = (rows as unknown as { rows: Array<{ details: Record<string, unknown> }> }).rows;
    if (r[0]) return r[0];
    await new Promise((r) => setTimeout(r, 25));
  }
  return null;
}

describe("firmContextMiddleware — fail-close + audit (round-5)", () => {
  beforeEach(async () => {
    // Clear stale denials so readLatestDenial can't pick up a previous run.
    await db.execute(sql`
      DELETE FROM audit_log
      WHERE entity_type = 'access_denied'
        AND action IN ('firm_context_no_user','firm_context_missing_claim','firm_context_not_found')
    `);
  });

  test("missing req.user → 401 + audit firm_context_no_user", async () => {
    const req = makeReq();
    const res = makeRes();
    const { nextCalled } = await runMw(req, res);
    assert.equal(nextCalled, false);
    assert.equal(res.statusCode, 401);
    assert.deepEqual(res.body, { error: "Authentication required" });
    const audit = await readLatestDenial("firm_context_no_user");
    assert.ok(audit, "expected an audit row with action=firm_context_no_user");
    assert.equal(audit!.details.path, "/leads");
    assert.equal(audit!.details.method, "GET");
  });

  test("req.user without firm_id → 401 + audit firm_context_missing_claim", async () => {
    const req = makeReq({
      // user is set but firm_id absent — the auth-middleware contract
      // guarantees firm_id is always present, this branch is the
      // defense-in-depth for that contract being violated.
      user: {
        id: 42,
        email: "noclaim@mtos.test",
        name: "No Claim",
        role: "viewer",
      } as unknown as Request["user"],
    } as unknown as Partial<Request>);
    const res = makeRes();
    const { nextCalled } = await runMw(req, res);
    assert.equal(nextCalled, false);
    assert.equal(res.statusCode, 401);
    assert.deepEqual(res.body, { error: "Token missing firm context — please re-login" });
    const audit = await readLatestDenial("firm_context_missing_claim");
    assert.ok(audit, "expected an audit row with action=firm_context_missing_claim");
    assert.equal(audit!.details.user_id, 42);
  });

  test("firm_id claim points at non-existent firm → 401 + audit firm_context_not_found", async () => {
    const req = makeReq({
      user: {
        id: 99,
        email: "ghost@mtos.test",
        name: "Ghost",
        role: "viewer",
        firm_id: 9_999_999, // very unlikely to exist
      } as unknown as Request["user"],
    } as unknown as Partial<Request>);
    const res = makeRes();
    const { nextCalled } = await runMw(req, res);
    assert.equal(nextCalled, false);
    assert.equal(res.statusCode, 401);
    assert.deepEqual(res.body, { error: "Firm not found — please re-login" });
    const audit = await readLatestDenial("firm_context_not_found");
    assert.ok(audit, "expected an audit row with action=firm_context_not_found");
    assert.equal(audit!.details.claimed_firm_id, 9_999_999);
  });

  test("happy path: firm_id=1 (default firm) → next() and req.firm populated", async () => {
    const req = makeReq({
      user: {
        id: 1,
        email: "ok@mtos.test",
        name: "OK",
        role: "admin",
        firm_id: 1,
      } as unknown as Request["user"],
    } as unknown as Partial<Request>);
    const res = makeRes();
    const { nextCalled } = await runMw(req, res);
    assert.equal(nextCalled, true);
    assert.equal(res.statusCode, 0);
    const r = req as unknown as { firm?: { id: number; slug: string } };
    assert.equal(r.firm?.id, 1);
    assert.equal(r.firm?.slug, "default");
  });
});

after(async () => {
  // Same cleanup pattern as the route-matrix test — leave the table tidy
  // for the next test run.
  await db.execute(sql`
    DELETE FROM audit_log
    WHERE entity_type = 'access_denied'
      AND action IN ('firm_context_no_user','firm_context_missing_claim','firm_context_not_found')
  `);
});

void before; // keep the import in scope for symmetry with sibling tests
