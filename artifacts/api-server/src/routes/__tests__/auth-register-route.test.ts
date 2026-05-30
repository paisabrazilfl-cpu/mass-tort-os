// Focused coverage for POST /api/auth/register.
//
// Task #56 changed the success contract: registration no longer issues
// a JWT pair. The route now creates a pending user (email_verified_at
// NULL), enqueues a signed verification email, and replies 202 with
// { status: "pending_verification", message } so the UI can flip into
// the "check your inbox" panel without ever holding a token for an
// unverified account.
//
// This file pins the four user-visible outcomes the self-serve
// registration page depends on:
//   (a) happy path -> 202 with { status: "pending_verification", message }
//       and NO token / refresh_token / user fields.
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
const GATE_EMAIL = `register-gate-${TS}@mtos.test`;
const STRONG_PASSWORD = "Sup3r$ecret!Pa$$w0rd";

interface RegisterResponse {
  // Pending-verification 202 envelope (Task #56 happy path).
  status?: unknown;
  message?: unknown;
  // Legacy success fields — these MUST NOT appear on a 202 response now.
  // Kept on the type so assertions can still examine and reject them.
  token?: unknown;
  refresh_token?: unknown;
  expires_in?: unknown;
  user?: { id?: unknown; email?: unknown; name?: unknown; role?: unknown };
  // 4xx error envelope.
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
      sql`DELETE FROM mtos_users WHERE email IN (${HAPPY_EMAIL}, ${DUPE_EMAIL}, ${WEAK_EMAIL}, ${GATE_EMAIL})`,
    )
    .catch(() => {});
  await close();
});

test("(a) happy path: returns 202 pending_verification envelope and creates an unverified user row (no JWT issued)", async () => {
  const resp = await registerProbe({
    email: HAPPY_EMAIL,
    password: STRONG_PASSWORD,
    name: "Happy Path",
    terms_accepted: true,
  });
  assert.equal(
    resp.status,
    202,
    `expected 202, got ${resp.status} (body=${JSON.stringify(resp.body)})`,
  );
  assert.equal(
    resp.body.status,
    "pending_verification",
    "response envelope must announce the pending-verification state so the UI can flip into the check-your-email panel",
  );
  assert.equal(typeof resp.body.message, "string", "message must be a UI-renderable string");
  assert.match(
    String(resp.body.message),
    /verify|verification|email/i,
    "message must reference email verification so the UI does not need to translate copy",
  );
  // CRITICAL: an unverified account must NOT be granted a session. If
  // any of these fields ever leak back into the 202 envelope, the
  // verification gate can be trivially bypassed.
  assert.equal(resp.body.token, undefined, "no access token must be issued before verification");
  assert.equal(
    resp.body.refresh_token,
    undefined,
    "no refresh token must be issued before verification",
  );
  assert.equal(resp.body.user, undefined, "no user payload must be returned before verification");

  // The row exists but is pending: email_verified_at must be NULL and a
  // hashed verification token must be staged for /verify-email to consume.
  const rows = await db.execute(
    sql`SELECT email_verified_at, email_verification_token_hash, email_verification_token_expires_at FROM mtos_users WHERE email = ${HAPPY_EMAIL}`,
  );
  const r =
    (
      rows as unknown as {
        rows?: Array<{
          email_verified_at: unknown;
          email_verification_token_hash: unknown;
          email_verification_token_expires_at: unknown;
        }>;
      }
    ).rows ?? [];
  assert.equal(r.length, 1, "register must persist a user row even when issuing no token");
  assert.equal(
    r[0]?.email_verified_at,
    null,
    "freshly-registered users must start with email_verified_at = NULL",
  );
  assert.equal(
    typeof r[0]?.email_verification_token_hash,
    "string",
    "register must stage a SHA-256 hash of the verification token (never the plaintext)",
  );
  assert.ok(
    r[0]?.email_verification_token_expires_at,
    "register must stamp an expiry on the verification token so it cannot be replayed indefinitely",
  );
});

test("(b) duplicate email returns 409 { error: 'Email already registered' }", async () => {
  // Seed the dupe row via /register itself so we exercise the same write
  // path the conflict guard reads from. The seed call returns 202 now
  // (pending verification) but the duplicate-detection branch only
  // cares that the row exists — verification status is irrelevant.
  const seed = await registerProbe({
    email: DUPE_EMAIL,
    password: STRONG_PASSWORD,
    name: "Dupe Seed",
    terms_accepted: true,
  });
  assert.equal(seed.status, 202, `seed must succeed, got ${seed.status}`);

  const dupe = await registerProbe({
    email: DUPE_EMAIL,
    password: STRONG_PASSWORD,
    name: "Dupe Retry",
    terms_accepted: true,
  });
  assert.equal(dupe.status, 409, `expected 409 on duplicate email, got ${dupe.status}`);
  assert.equal(dupe.body.error, "Email already registered");
});

test("(c) weak password returns 400 with the complexity-rule message", async () => {
  const resp = await registerProbe({
    email: WEAK_EMAIL,
    password: "short",
    name: "Weak Password",
    terms_accepted: true,
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
    terms_accepted: true,
  });
  assert.equal(resp.status, 409, `expected 409 on reserved email, got ${resp.status}`);
  assert.equal(
    resp.body.error,
    "Email already registered",
    "reserved-email response must match duplicate-email response verbatim so the endpoint cannot be used to enumerate reserved addresses",
  );
});

test("(e) clickwrap gate: registration without terms_accepted is rejected and creates no user row", async () => {
  // Omitting terms_accepted entirely must fail the z.literal(true) gate
  // BEFORE any user state is created — there must be no way to register
  // without affirmatively accepting the Terms.
  const missing = await registerProbe({
    email: GATE_EMAIL,
    password: STRONG_PASSWORD,
    name: "No Terms",
  });
  assert.equal(
    missing.status,
    400,
    `registration without terms_accepted must be rejected, got ${missing.status}`,
  );

  // terms_accepted:false must be rejected identically (z.literal(true)).
  const declined = await registerProbe({
    email: GATE_EMAIL,
    password: STRONG_PASSWORD,
    name: "Declined Terms",
    terms_accepted: false,
  });
  assert.equal(
    declined.status,
    400,
    `registration with terms_accepted:false must be rejected, got ${declined.status}`,
  );

  // No user row may exist for the gate-blocked email.
  const rows = await db.execute(sql`SELECT id FROM mtos_users WHERE email = ${GATE_EMAIL}`);
  const r = (rows as unknown as { rows?: Array<{ id: number }> }).rows ?? [];
  assert.equal(r.length, 0, "a terms-gate failure must not create a user row");
});
