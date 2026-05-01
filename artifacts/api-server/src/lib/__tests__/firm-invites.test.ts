// Coverage for the two-phase claim semantics of firm-invite helpers.
//
// The register handler depends on three properties of these helpers:
//
//   1. Single-use is authoritative: a successful lockInviteByToken
//      flips the row out of the claimable set inside the same UPDATE,
//      so a second lock of the same plaintext returns null.
//   2. Concurrent locks cannot both win: when two callers race the same
//      token, exactly one returns a row and the other returns null.
//      Without this, two parallel /register requests could both bind a
//      new user to the invited firm — defeating the whole point of a
//      single-use invite.
//   3. Expired invites are not lockable: even with claimed_at IS NULL,
//      a row whose expires_at has passed must not be lockable.
//
// We exercise the helpers directly (no HTTP) so the tests are fast and
// the assertions point at the exact line that fails — matching how the
// route handler depends on them. Inserts go through `db.execute(sql\`...\`)`
// so we don't need the registration path's createUser side-effects.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "crypto";
import { db, firmsTable } from "@workspace/db";
import { sql } from "drizzle-orm";
import {
  hashInviteToken,
  lockInviteByToken,
  attachInviteUser,
  getInvitePreviewByToken,
} from "../firm-invites";

// Audit writes off — none of these tests assert audit shape.
process.env["RBAC_DISABLE_AUDIT"] = "1";

const TS = Date.now();
const FIRM_NAME = `Invite Race Firm ${TS}`;
const ADMIN_EMAIL = `invite-race-admin-${TS}@mtos.test`;

let firmId = 0;
let adminUserId = 0;

// Helper: insert an invite row directly so we control token, expiry,
// and the claimed_at state without going through the admin route.
async function seedInvite(opts: {
  plaintext?: string;
  expiresInMs?: number;
}): Promise<{ id: number; plaintext: string }> {
  const plaintext = opts.plaintext ?? crypto.randomBytes(32).toString("hex");
  const tokenHash = hashInviteToken(plaintext);
  const expiresAt = new Date(Date.now() + (opts.expiresInMs ?? 60_000));
  const result = await db.execute(sql`
    INSERT INTO firm_invites (
      firm_id, token_hash, email_prefill, expires_at, created_by_user_id
    ) VALUES (
      ${firmId}, ${tokenHash}, NULL, ${expiresAt}, ${adminUserId}
    ) RETURNING id
  `);
  const rows = (result as unknown as { rows?: Array<{ id: number }> }).rows ?? [];
  if (!rows[0]) throw new Error("seedInvite: insert returned no row");
  return { id: rows[0].id, plaintext };
}

before(async () => {
  // Real firm so the FK on firm_invites.firm_id holds.
  const [firm] = await db
    .insert(firmsTable)
    .values({ name: FIRM_NAME, slug: `invite-race-firm-${TS}` })
    .returning({ id: firmsTable.id });
  if (!firm) throw new Error("seed firm failed");
  firmId = firm.id;

  // Real user so the FK on created_by_user_id holds. We bypass the
  // register helper because we don't need a verifiable login — only
  // an id of an existing mtos_users row.
  // We deliberately skip email_verified_at here — that column is part
  // of the pre-existing drift item tracked in followup #63 and is not
  // present on every dev DB. The invite helpers do not read it.
  const userIns = await db.execute(sql`
    INSERT INTO mtos_users (email, name, role, password_hash, firm_id)
    VALUES (${ADMIN_EMAIL}, 'Invite Race Admin', 'admin', 'x', ${firmId})
    RETURNING id
  `);
  const urows = (userIns as unknown as { rows?: Array<{ id: number }> }).rows ?? [];
  if (!urows[0]) throw new Error("seed admin failed");
  adminUserId = urows[0].id;
});

after(async () => {
  // Clean order matters: invites → users → firm. Tolerate missing rows
  // (e.g. if a test failed before insert) so cleanup never masks the
  // real assertion failure.
  await db.execute(sql`DELETE FROM firm_invites WHERE firm_id = ${firmId}`).catch(() => {});
  await db.execute(sql`DELETE FROM mtos_users WHERE id = ${adminUserId}`).catch(() => {});
  await db.execute(sql`DELETE FROM firms WHERE id = ${firmId}`).catch(() => {});
});

test("lockInviteByToken consumes the invite atomically: a second lock of the same token returns null", async () => {
  const { id, plaintext } = await seedInvite({});

  const first = await lockInviteByToken(plaintext);
  assert.ok(first, "first lock must return the invite row");
  assert.equal(first?.id, id);
  assert.equal(first?.firm_id, firmId);

  const second = await lockInviteByToken(plaintext);
  assert.equal(
    second,
    null,
    "second lock of an already-claimed invite must return null — single-use is the whole point",
  );

  // Preview must also stop returning the row, since the UI relies on
  // the same `claimed_at IS NULL` predicate to decide when to render
  // the joining-firm banner vs the invalid-link warning.
  const preview = await getInvitePreviewByToken(plaintext);
  assert.equal(preview, null, "preview must reflect consumed state");
});

test("two parallel locks of the same invite: exactly one wins, the loser gets null", async () => {
  const { plaintext } = await seedInvite({});

  // Fire both UPDATEs without awaiting in between so the database is
  // the arbiter of the race rather than node's microtask order. This
  // is the closest thing to "two concurrent /register POSTs" we can
  // exercise without standing up two HTTP clients.
  const [a, b] = await Promise.all([
    lockInviteByToken(plaintext),
    lockInviteByToken(plaintext),
  ]);

  const winners = [a, b].filter((r) => r !== null);
  const losers = [a, b].filter((r) => r === null);
  assert.equal(
    winners.length,
    1,
    `exactly one parallel lock must win, got ${winners.length} winners (a=${JSON.stringify(a)} b=${JSON.stringify(b)})`,
  );
  assert.equal(losers.length, 1, "the loser must get null so the route handler can return 4xx");
});

test("expired invite cannot be locked even when claimed_at IS NULL", async () => {
  const { plaintext } = await seedInvite({ expiresInMs: -1_000 });

  const locked = await lockInviteByToken(plaintext);
  assert.equal(locked, null, "expired invite must not be lockable");

  const preview = await getInvitePreviewByToken(plaintext);
  assert.equal(preview, null, "expired invite must not preview as valid");
});

test("attachInviteUser stitches user_id onto a locked row and is safely idempotent", async () => {
  const { id, plaintext } = await seedInvite({});
  const locked = await lockInviteByToken(plaintext);
  assert.ok(locked);

  await attachInviteUser(id, adminUserId);
  const r1 = await db.execute(
    sql`SELECT claimed_by_user_id FROM firm_invites WHERE id = ${id}`,
  );
  const rows1 = (r1 as unknown as { rows?: Array<{ claimed_by_user_id: number | null }> }).rows ?? [];
  assert.equal(
    rows1[0]?.claimed_by_user_id,
    adminUserId,
    "attachInviteUser must populate claimed_by_user_id post-lock",
  );

  // Re-running attachInviteUser must not throw or revert the binding.
  // The handler doesn't retry today, but the operation must remain
  // safe to re-issue (e.g. operator-driven recovery).
  await attachInviteUser(id, adminUserId);
  const r2 = await db.execute(
    sql`SELECT claimed_by_user_id FROM firm_invites WHERE id = ${id}`,
  );
  const rows2 = (r2 as unknown as { rows?: Array<{ claimed_by_user_id: number | null }> }).rows ?? [];
  assert.equal(rows2[0]?.claimed_by_user_id, adminUserId, "second attach must remain idempotent");
});
