import test from "node:test";
import assert from "node:assert/strict";
import { idsMiddleware } from "../ids";

test("idsMiddleware: allows normal clean request payloads", async () => {
  const middleware = idsMiddleware();
  let passed = false;

  const req: any = {
    originalUrl: "/api/leads?status=pending&page=1&limit=20&sort=desc",
    query: { status: "pending", page: "1", limit: "20", sort: "desc", tort: "Roundup" },
    body: { name: "Jane Doe", email: "jane@example.com", phone: "555-123-4567", state: "CA", firm_id: 1, age: 45 },
    headers: {},
    socket: { remoteAddress: "127.0.0.99" },
  };

  const res: any = {
    status() { return this; },
    json() { return this; },
  };

  await middleware(req, res, () => {
    passed = true;
  });

  assert.equal(passed, true, "Clean request should pass through");
});

test("idsMiddleware: blocks critical SQL injection in query parameters with 403", async () => {
  const middleware = idsMiddleware();
  let passed = false;
  let statusCode = 0;
  let responseBody: any = null;

  const req: any = {
    originalUrl: "/api/leads?status=SELECT%20*%20FROM%20users",
    query: { status: "SELECT * FROM users" },
    body: {},
    headers: {},
    socket: { remoteAddress: "127.0.0.100" },
  };

  const res: any = {
    status(code: number) {
      statusCode = code;
      return this;
    },
    json(body: any) {
      responseBody = body;
      return this;
    },
  };

  await middleware(req, res, () => {
    passed = true;
  });

  assert.equal(passed, false, "SQLi request should not call next()");
  assert.equal(statusCode, 403, "Should return 403 Forbidden for critical threats");
  assert.equal(responseBody?.code, "FORBIDDEN");
});

test("idsMiddleware: blocks critical command injection in body with 403", async () => {
  const middleware = idsMiddleware();
  let passed = false;
  let statusCode = 0;

  const req: any = {
    originalUrl: "/api/leads",
    query: {},
    body: { comment: "$(whoami)" },
    headers: {},
    socket: { remoteAddress: "127.0.0.101" },
  };

  const res: any = {
    status(code: number) {
      statusCode = code;
      return this;
    },
    json() {
      return this;
    },
  };

  await middleware(req, res, () => {
    passed = true;
  });

  assert.equal(passed, false, "Command injection request should not call next()");
  assert.equal(statusCode, 403, "Should return 403 Forbidden for critical threats");
});

test("idsMiddleware: logs high-severity XSS threat without blocking immediately", async () => {
  const middleware = idsMiddleware();
  let passed = false;

  const req: any = {
    originalUrl: "/api/leads",
    query: {},
    body: { comment: "<script>alert('xss')</script>" },
    headers: {},
    socket: { remoteAddress: "127.0.0.102" },
  };

  const res: any = {
    status() { return this; },
    json() { return this; },
  };

  await middleware(req, res, () => {
    passed = true;
  });

  assert.equal(passed, true, "High severity threat logs alert but lets request proceed per policy");
});
