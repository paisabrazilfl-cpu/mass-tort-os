// Focused coverage for GET /api/auth/verify-email (Task #56).
//
// The route trades a single-use token for a JWT pair. It is the only
// path that flips email_verified_at from NULL to NOW(), so any
// regression here either (a) lets unverified accounts hold sessions,
// or (b) lets the link become a confirmation oracle that leaks
// "this token used to exist". This file pins six branches:
//
//   (1) happy path: register stages a token; the verifier accepts it,
//       returns the JWT-pair envelope, and stamps email_verified_at.
//   (2) replay: a second consumption of the same token fails with the
//       generic invalid_token envelope (no JWT issued, no row mutated
//       a second time).
//   (3) malformed token (wrong length / non-hex) returns the SAME
//       generic 400 — must not leak that the token shape was invalid
//       vs. that it didn't match a row.
//   (4) missing token query parameter returns the same generic 400.
//   (5) unknown but well-formed token returns the same generic 400.
//   (6) login on the unverified row 403s with code=email_unverified.
//       Verifying the email then unblocks login.
//
// We boot the real Express app on an ephemeral port (mirrors the
// pattern used in auth-register-route.test.ts) so authRateLimit + Zod
// + the handler are all exercised together.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import type { Express } from "express";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import crypto from "node:crypto";

// Audit writes off — not what these tests pin, and they would otherwise
// add a row per verification.
process.env["RBAC_DISABLE_AUDIT"] = "1";

function closeAllConnections(server: import("node:http").Server): void {
  const fn = (server as unknown as { closeAllConnections?: () => void }).closeAllConnections;
  if (typeof fn === "function") fn.call(server);
}

let baseUrl = "";
let close: () => Promise<void> = async () => {};

const TS = Date.now();
const STRONG_PASSWORD = "Sup3r$ecret!Pa$$w0rd";

interface JsonResponse {
  status: number;
  body: Record<string, unknown>;
}

async function jsonRequest(path: string, init?: RequestInit): Promise<JsonResponse> {
  const res = await fetch(`${baseUrl}${path}`, init);
  const text = await res.text();
  let parsed: Record<string, unknown> = {};
  if (text.length > 0) {
    try {
      parsed = JSON.parse(text) as Record<string, unknown>;
    } catch {
      parsed = { error: text };
    }
  }
  return { status: res.status, body: parsed };
}

function postJson(path: string, body: unknown): Promise<JsonResponse> {
  return jsonRequest(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

// Pull the SHA-256 hash stored at register time and recover the
// plaintext token by re-deriving it from a candidate. We have no way
// to recover the original 32-byte token from the hash alone (that's
// the point), so register seeds a known-shape token for this test by
// going through the real /register route and then asking the table
// for the hash; we then hand-craft a synthetic flow:
//   - Use crypto.randomBytes + the real hash function to mint an
//     equivalent pair.
//   - UPDATE mtos_users with our token_hash so the test owns both
//     ends of the link.
// This avoids needing a test seam in the production code path.
async function stageVerificationToken(email: string): Promise<{ token: string; hash: string }> {
  const token = crypto.randomBytes(32).toString("hex");
  const hash = crypto.createHash("sha256").update(token).digest("hex");
  // Stamp a 24h expiry so the test isn't time-sensitive.
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
  await db.execute(
    sql`UPDATE mtos_users SET email_verification_token_hash = ${hash}, email_verification_token_expires_at = ${expiresAt}, email_verified_at = NULL WHERE email = ${email}`,
  );
  return { token, hash };
}

const REG_EMAILS = {
  happy: `verify-happy-${TS}@mtos.test`,
  replay: `verify-replay-${TS}@mtos.test`,
  loginGate: `verify-login-${TS}@mtos.test`,
};

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
      sql`DELETE FROM mtos_users WHERE email IN (${REG_EMAILS.happy}, ${REG_EMAILS.replay}, ${REG_EMAILS.loginGate})`,
    )
    .catch(() => {});
  await close();
});

test("(1) happy path: known-good token returns JWT pair and stamps email_verified_at", async () => {
  const reg = await postJson("/api/auth/register", {
    email: REG_EMAILS.happy,
    password: STRONG_PASSWORD,
    name: "Verify Happy",
  });
  assert.equal(reg.status, 202, `register must return 202 (got ${reg.status})`);

  const { token } = await stageVerificationToken(REG_EMAILS.happy);
  const resp = await jsonRequest(`/api/auth/verify-email?token=${token}`, { method: "GET" });
  assert.equal(
    resp.status,
    200,
    `verify-email must accept the staged token (got ${resp.status}, body=${JSON.stringify(resp.body)})`,
  );

  // JWT-pair envelope mirrors what /register used to return so the
  // verify-email page can hand them straight to the auth store.
  assert.equal(typeof resp.body["token"], "string", "must return an access token");
  assert.ok(
    typeof resp.body["token"] === "string" && (resp.body["token"] as string).split(".").length === 3,
    "access token must be a 3-segment JWT",
  );
  assert.equal(typeof resp.body["refresh_token"], "string", "must return a refresh token");
  assert.equal(resp.body["expires_in"], 900);
  const user = resp.body["user"] as { id?: number; email?: string; role?: string } | undefined;
  assert.ok(user, "user payload must be present");
  assert.equal(user!.email, REG_EMAILS.happy);
  assert.equal(user!.role, "viewer");

  // The row must be flipped to verified and the token cleared so it
  // can never be replayed (covered explicitly by test (2)).
  const rows = await db.execute(
    sql`SELECT email_verified_at, email_verification_token_hash, email_verification_token_expires_at FROM mtos_users WHERE email = ${REG_EMAILS.happy}`,
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
  assert.equal(r.length, 1);
  assert.ok(r[0]?.email_verified_at, "email_verified_at must be set");
  assert.equal(
    r[0]?.email_verification_token_hash,
    null,
    "verification token hash must be cleared so the link cannot be replayed",
  );
  assert.equal(
    r[0]?.email_verification_token_expires_at,
    null,
    "verification token expiry must be cleared",
  );
});

test("(2) replay: same token a second time returns generic invalid_token (no second JWT)", async () => {
  const reg = await postJson("/api/auth/register", {
    email: REG_EMAILS.replay,
    password: STRONG_PASSWORD,
    name: "Verify Replay",
  });
  assert.equal(reg.status, 202);

  const { token } = await stageVerificationToken(REG_EMAILS.replay);

  const first = await jsonRequest(`/api/auth/verify-email?token=${token}`, { method: "GET" });
  assert.equal(first.status, 200, "first consumption must succeed");

  const second = await jsonRequest(`/api/auth/verify-email?token=${token}`, { method: "GET" });
  assert.equal(second.status, 400, "replay must be rejected with the generic 400");
  assert.equal(
    second.body["code"],
    "invalid_token",
    "replay must reuse the generic invalid_token code (no enumeration oracle)",
  );
  assert.equal(
    second.body["token"],
    undefined,
    "replay MUST NOT issue a second JWT — that would defeat the single-use property",
  );
});

test("(3) malformed token returns the same generic invalid_token 400", async () => {
  // Wrong length / non-hex characters cannot match any stored hash;
  // both must collapse to the same generic envelope.
  const tooShort = await jsonRequest(`/api/auth/verify-email?token=deadbeef`, { method: "GET" });
  assert.equal(tooShort.status, 400);
  assert.equal(tooShort.body["code"], "invalid_token");

  const nonHex = await jsonRequest(
    `/api/auth/verify-email?token=${"z".repeat(64)}`,
    { method: "GET" },
  );
  assert.equal(nonHex.status, 400);
  assert.equal(nonHex.body["code"], "invalid_token");
});

test("(4) missing token returns the same generic invalid_token 400", async () => {
  const resp = await jsonRequest(`/api/auth/verify-email`, { method: "GET" });
  assert.equal(resp.status, 400);
  assert.equal(
    resp.body["code"],
    "invalid_token",
    "missing-token branch must reuse the generic envelope so the absence is indistinguishable from a bad token",
  );
});

test("(5) well-formed but unknown token returns the same generic invalid_token 400", async () => {
  // 64 hex chars that match the schema but no stored hash. Must not
  // leak that the format was correct — same envelope as (3) and (4).
  const unknown = crypto.randomBytes(32).toString("hex");
  const resp = await jsonRequest(`/api/auth/verify-email?token=${unknown}`, { method: "GET" });
  assert.equal(resp.status, 400);
  assert.equal(resp.body["code"], "invalid_token");
  assert.equal(resp.body["token"], undefined);
});

test("(6) /login refuses unverified accounts with code=email_unverified; verification unblocks it", async () => {
  const reg = await postJson("/api/auth/register", {
    email: REG_EMAILS.loginGate,
    password: STRONG_PASSWORD,
    name: "Login Gate",
  });
  assert.equal(reg.status, 202);

  const blocked = await postJson("/api/auth/login", {
    email: REG_EMAILS.loginGate,
    password: STRONG_PASSWORD,
  });
  assert.equal(
    blocked.status,
    403,
    `unverified login must 403 (got ${blocked.status} body=${JSON.stringify(blocked.body)})`,
  );
  assert.equal(
    blocked.body["code"],
    "email_unverified",
    "unverified login must surface a stable code so the UI can render the verify-your-email copy",
  );
  assert.equal(blocked.body["token"], undefined, "unverified login MUST NOT issue a JWT");

  // Verify, then prove login now succeeds with the same credentials.
  const { token } = await stageVerificationToken(REG_EMAILS.loginGate);
  const verified = await jsonRequest(`/api/auth/verify-email?token=${token}`, { method: "GET" });
  assert.equal(verified.status, 200, "verification must succeed");

  const allowed = await postJson("/api/auth/login", {
    email: REG_EMAILS.loginGate,
    password: STRONG_PASSWORD,
  });
  assert.equal(
    allowed.status,
    200,
    `verified login must succeed (got ${allowed.status} body=${JSON.stringify(allowed.body)})`,
  );
  assert.equal(typeof allowed.body["token"], "string", "verified login must issue a JWT");
});
