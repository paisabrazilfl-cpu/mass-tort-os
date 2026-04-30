// Focused coverage for POST /api/auth/register.
//
// The route is wired into rbac-route-matrix's "reserved-email" check, but
// that test asserts ONE branch (the system@mtos.local oracle-blocking
// 409). This file pins the four user-visible outcomes the new
// self-serve registration page depends on:
//   (a) happy path -> 201 with { token, refresh_token, expires_in, user }.
//   (b) duplicate-email collision -> 409 { error: "Email already registered" }.
//   (c) weak password -> 400 with the verbatim complexity-rule string the
//       UI surfaces inline.
//   (d) reserved-email collision -> SAME 409 shape as (b) so the route
//       does not become an enumeration oracle for system addresses.
//
// We hit the booted Express app on an ephemeral port (same pattern the
// route-matrix uses) instead of poking the handler directly so we
// exercise authRateLimit + Zod parsing + the handler in one shot.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import type { Express } from "express";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";

// Audit writes off — they are not what this test pins, and the route
// would otherwise insert one audit row per 201 here. The rbac.test.ts
// file owns "register writes an audit row" coverage.
process.env["RBAC_DISABLE_AUDIT"] = "1";

function closeAllConnections(server: import("node:http").Server): void {
  const fn = (server as unknown as { closeAllConnections?: () => void }).closeAllConnections;
  if (typeof fn === "function") fn.call(server);
}

let baseUrl = "";
let close: () => Promise<void> = async () => {};

// Suffix every test email with a fresh nanosecond-precision timestamp so
// re-runs against a non-pristine DB do not collide with prior rows. We
// still clean up in `after` for hygiene.
const TS = Date.now();
const HAPPY_EMAIL = `register-happy-${TS}@mtos.test`;
const DUPE_EMAIL = `register-dupe-${TS}@mtos.test`;
const WEAK_EMAIL = `register-weak-${TS}@mtos.test`;
const STRONG_PASSWORD = "Sup3r$ecret!Pa$$w0rd";

interface RegisterResponse {
  token?: unknown;
  refresh_token?: unknown;
  expires_in?: unknown;
  user?: { id?: unknown; email?: unknown; name?: unknown; role?: unknown };
  error?: unknown;
}

async function registerProbe(body: unknown): Promise<{ status: number; body: RegisterResponse }> {
  const res = await fetch(`${baseUrl}/api/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let parsed: RegisterResponse = {};
  if (text.length > 0) {
    try {
      parsed = JSON.parse(text) as RegisterResponse;
    } catch {
      parsed = { error: text };
    }
  }
  return { status: res.status, body: parsed };
}

before(async () => {
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
      sql`DELETE FROM mtos_users WHERE email IN (${HAPPY_EMAIL}, ${DUPE_EMAIL}, ${WEAK_EMAIL})`,
    )
    .catch(() => {});
  await close();
});

test("(a) happy path: returns 201 with JWT pair, refresh token, viewer role, and bound user row", async () => {
  const resp = await registerProbe({
    email: HAPPY_EMAIL,
    password: STRONG_PASSWORD,
    name: "Happy Path",
  });
  assert.equal(resp.status, 201, `expected 201, got ${resp.status} (body=${JSON.stringify(resp.body)})`);
  assert.equal(typeof resp.body.token, "string", "JWT access token must be a string");
  assert.ok(
    typeof resp.body.token === "string" && resp.body.token.split(".").length === 3,
    "access token must be a 3-segment JWT",
  );
  assert.equal(typeof resp.body.refresh_token, "string", "refresh token must be a string");
  assert.equal(resp.body.expires_in, 900, "access token TTL must be 900s");
  assert.ok(resp.body.user, "user payload must be present");
  assert.equal(resp.body.user?.email, HAPPY_EMAIL);
  assert.equal(resp.body.user?.name, "Happy Path");
  // Server always assigns viewer; the request did not carry a role.
  assert.equal(resp.body.user?.role, "viewer", "freshly-registered users must default to viewer role");
  assert.equal(typeof resp.body.user?.id, "number");
});

test("(b) duplicate email returns 409 { error: 'Email already registered' }", async () => {
  // Seed the dupe row via /register itself so we exercise the same write
  // path the conflict guard reads from.
  const seed = await registerProbe({
    email: DUPE_EMAIL,
    password: STRONG_PASSWORD,
    name: "Dupe Seed",
  });
  assert.equal(seed.status, 201, `seed must succeed, got ${seed.status}`);

  const dupe = await registerProbe({
    email: DUPE_EMAIL,
    password: STRONG_PASSWORD,
    name: "Dupe Retry",
  });
  assert.equal(dupe.status, 409, `expected 409 on duplicate email, got ${dupe.status}`);
  assert.equal(dupe.body.error, "Email already registered");
});

test("(c) weak password returns 400 with the complexity-rule message", async () => {
  const resp = await registerProbe({
    email: WEAK_EMAIL,
    password: "short",
    name: "Weak Password",
  });
  assert.equal(resp.status, 400, `expected 400 on weak password, got ${resp.status}`);
  assert.equal(typeof resp.body.error, "string", "error must be a string the UI can render verbatim");
  assert.match(
    String(resp.body.error),
    /at least 12 characters/i,
    "error must mention the 12-char minimum so the UI does not have to translate",
  );
  // Confirm no row was created.
  const rows = await db.execute(sql`SELECT id FROM mtos_users WHERE email = ${WEAK_EMAIL}`);
  const r = (rows as unknown as { rows?: Array<{ id: number }> }).rows ?? [];
  assert.equal(r.length, 0, "weak-password registration must not create a user row");
});

test("(d) reserved email (system@mtos.local) returns the SAME 409 shape as a duplicate (no oracle)", async () => {
  const resp = await registerProbe({
    email: "system@mtos.local",
    password: STRONG_PASSWORD,
    name: "Reserved Attempt",
  });
  assert.equal(resp.status, 409, `expected 409 on reserved email, got ${resp.status}`);
  assert.equal(
    resp.body.error,
    "Email already registered",
    "reserved-email response must match duplicate-email response verbatim so the endpoint cannot be used to enumerate reserved addresses",
  );
});
