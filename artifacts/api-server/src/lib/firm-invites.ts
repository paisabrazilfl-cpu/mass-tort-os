// Firm-invite token helpers.
//
// An invite is a single-use claim that binds a new self-serve
// registration to a specific firm instead of the seeded default firm.
// The plaintext token is generated here, returned to the route so it can
// be embedded in the link surfaced to the admin (who then shares it),
// and only the SHA-256 hash is persisted. We never persist the
// plaintext, so a database leak does not let an attacker replay an
// outstanding invite.
//
// Hash choice: SHA-256 is correct here for the same reasons as the
// email-verification token (high-entropy, single-use, short-lived,
// never user-supplied) — argon2/scrypt would only add latency.

import crypto from "crypto";
import { db, firmInvitesTable, firmsTable } from "@workspace/db";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { enqueueJob } from "./queue";
import { resolveAppPublicUrl } from "./email-verification";
import { logger } from "./logger";

// Single-use semantics are enforced via the `claimed_at` column rather
// than `claimed_by_user_id`. The reason: registration needs to know the
// firm_id BEFORE it has a user.id (so it can pass firm_id to
// createUser), but it also needs the claim to be atomic so two parallel
// requesters can't both bind to the same invite. Splitting the claim
// into "lock" (sets claimed_at, returns firm_id) + "attach user" (sets
// claimed_by_user_id post-insert) lets the database be the arbiter of
// the single-use race while still letting us reuse the existing
// createUser helper unmodified. The downside is that a crash between
// lock and attach leaves an invite with claimed_at IS NOT NULL but
// claimed_by_user_id IS NULL — that is fine for our purposes (the
// invite is consumed; an admin must mint a new one), and it is strictly
// safer than the inverse race (allowing reuse).

const TOKEN_BYTES = 32;
// Default 14 days. Long enough that an admin can hand it off via a slow
// channel (mail, ticket) but short enough that a forgotten link goes
// stale quickly. Operator can override at create time.
const DEFAULT_TTL_MS = 14 * 24 * 60 * 60 * 1000;
export const MAX_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export interface InviteToken {
  /** URL-safe plaintext token to embed in the invite link. */
  plaintext: string;
  /** SHA-256 hex digest of the plaintext — what gets persisted. */
  hash: string;
  /** Absolute expiry timestamp; persisted alongside the hash. */
  expiresAt: Date;
}

export function generateInviteToken(ttlMs: number = DEFAULT_TTL_MS): InviteToken {
  const plaintext = crypto.randomBytes(TOKEN_BYTES).toString("hex");
  const hash = hashInviteToken(plaintext);
  const expiresAt = new Date(Date.now() + ttlMs);
  return { plaintext, hash, expiresAt };
}

export function hashInviteToken(plaintext: string): string {
  return crypto.createHash("sha256").update(plaintext, "utf8").digest("hex");
}

export interface CreateInviteInput {
  firmId: number;
  createdByUserId: number;
  emailPrefill?: string | null;
  ttlMs?: number;
}

export interface CreatedInvite {
  id: number;
  plaintext: string;
  expiresAt: Date;
}

export async function createInvite(input: CreateInviteInput): Promise<CreatedInvite> {
  const ttl = Math.min(input.ttlMs ?? DEFAULT_TTL_MS, MAX_TTL_MS);
  const token = generateInviteToken(ttl);
  const [row] = await db
    .insert(firmInvitesTable)
    .values({
      firm_id: input.firmId,
      token_hash: token.hash,
      email_prefill: input.emailPrefill ?? null,
      expires_at: token.expiresAt,
      created_by_user_id: input.createdByUserId,
    })
    .returning({ id: firmInvitesTable.id });
  if (!row) throw new Error("createInvite: insert returned no row");
  return { id: row.id, plaintext: token.plaintext, expiresAt: token.expiresAt };
}

export interface InvitePreview {
  firm_id: number;
  firm_name: string;
  email_prefill: string | null;
  expires_at: Date;
}

/**
 * Look up an outstanding invite by plaintext token (we hash before
 * querying). Returns null for any failure mode — wrong token, expired,
 * already-claimed — so the caller can render one generic "invalid or
 * expired" message instead of leaking which case applied.
 */
export async function getInvitePreviewByToken(
  plaintext: string,
): Promise<InvitePreview | null> {
  const tokenHash = hashInviteToken(plaintext);
  const rows = await db
    .select({
      firm_id: firmInvitesTable.firm_id,
      firm_name: firmsTable.name,
      email_prefill: firmInvitesTable.email_prefill,
      expires_at: firmInvitesTable.expires_at,
    })
    .from(firmInvitesTable)
    .innerJoin(firmsTable, eq(firmInvitesTable.firm_id, firmsTable.id))
    .where(
      and(
        eq(firmInvitesTable.token_hash, tokenHash),
        isNull(firmInvitesTable.claimed_at),
      ),
    )
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  if (row.expires_at.getTime() <= Date.now()) return null;
  return row;
}

export interface LockedInvite {
  id: number;
  firm_id: number;
}

/**
 * Step 1 of two-phase claim: atomically reserve the invite. The UPDATE
 * predicate enforces single-use semantics at the database level:
 *
 *   - token_hash = $hash    — match the row by hash
 *   - claimed_at IS NULL    — never been reserved
 *   - expires_at > NOW()    — still within window
 *
 * Stamping `claimed_at = NOW()` flips the row out of the claimable set
 * inside the same statement, so two concurrent registrations racing the
 * same token both run this UPDATE but only one returns a row. The loser
 * gets null and the route handler returns 4xx — there is no path where
 * a registration succeeds without winning this UPDATE.
 *
 * `claimed_by_user_id` is NOT set here because we don't yet have a
 * user.id. It is set in step 2 by `attachInviteUser` after the user row
 * is inserted. A crash between the two steps consumes the invite
 * (correct: never reusable) but leaves claimed_by_user_id NULL until an
 * operator stitches it from audit_log — strictly safer than the
 * inverse failure mode.
 *
 * Returns the firm_id the new user must be bound to, or null when the
 * token did not match any claimable row.
 */
export async function lockInviteByToken(
  plaintext: string,
): Promise<LockedInvite | null> {
  const tokenHash = hashInviteToken(plaintext);
  const rows = await db
    .update(firmInvitesTable)
    .set({ claimed_at: new Date() })
    .where(
      and(
        eq(firmInvitesTable.token_hash, tokenHash),
        isNull(firmInvitesTable.claimed_at),
        sql`${firmInvitesTable.expires_at} > NOW()`,
      ),
    )
    .returning({
      id: firmInvitesTable.id,
      firm_id: firmInvitesTable.firm_id,
    });
  return rows[0] ?? null;
}

/**
 * Step 2 of two-phase claim: stitch the new user.id onto the row that
 * was reserved by `lockInviteByToken`. Idempotent and best-effort —
 * failure here does NOT roll back registration, since the invite is
 * already authoritatively consumed (claimed_at is set). The audit log
 * for the registration carries the user_id so an operator can recover
 * the binding even if this UPDATE somehow loses the row.
 */
export async function attachInviteUser(
  inviteId: number,
  userId: number,
): Promise<void> {
  await db
    .update(firmInvitesTable)
    .set({ claimed_by_user_id: userId })
    .where(eq(firmInvitesTable.id, inviteId));
}

export interface FirmInviteRow {
  id: number;
  email_prefill: string | null;
  expires_at: Date;
  claimed_by_user_id: number | null;
  claimed_at: Date | null;
  created_by_user_id: number;
  created_at: Date;
}

export async function listInvitesForFirm(firmId: number): Promise<FirmInviteRow[]> {
  return db
    .select({
      id: firmInvitesTable.id,
      email_prefill: firmInvitesTable.email_prefill,
      expires_at: firmInvitesTable.expires_at,
      claimed_by_user_id: firmInvitesTable.claimed_by_user_id,
      claimed_at: firmInvitesTable.claimed_at,
      created_by_user_id: firmInvitesTable.created_by_user_id,
      created_at: firmInvitesTable.created_at,
    })
    .from(firmInvitesTable)
    .where(eq(firmInvitesTable.firm_id, firmId))
    .orderBy(desc(firmInvitesTable.created_at))
    .limit(100);
}

/**
 * Revoke an outstanding (unclaimed) invite. Firm-scoped so an admin can
 * never delete another firm's invite even by guessing the id. Returns
 * false when no matching unclaimed invite existed.
 */
export async function revokeInvite(id: number, firmId: number): Promise<boolean> {
  const rows = await db
    .delete(firmInvitesTable)
    .where(
      and(
        eq(firmInvitesTable.id, id),
        eq(firmInvitesTable.firm_id, firmId),
        isNull(firmInvitesTable.claimed_at),
      ),
    )
    .returning({ id: firmInvitesTable.id });
  return rows.length > 0;
}

/** Build the user-facing invite-acceptance URL (the SPA /register page). */
export function buildInviteUrl(plaintext: string): string {
  return `${resolveAppPublicUrl()}/register?invite=${encodeURIComponent(plaintext)}`;
}

/**
 * Email a firm invitation. The recipient address IS the account they will
 * sign in with — registration locks the email to it. Delivery is enqueued
 * onto the job queue (same retry path as the verification email); never
 * throws back into the request.
 */
export async function sendFirmInviteEmail(
  to: string,
  firmName: string,
  plaintextToken: string,
): Promise<void> {
  const link = buildInviteUrl(plaintextToken);
  const safeFirm = (firmName || "your team").replace(/[<>&]/g, "");
  const safeTo = to.replace(/[<>&]/g, "");
  const subject = `You're invited to join ${safeFirm} on Mass Tort OS`;
  const text =
    `You've been invited to join ${safeFirm} on Mass Tort OS.\n\n` +
    `Set up your account here — ${safeTo} will be your sign-in address:\n\n${link}\n\n` +
    `This invitation expires in 14 days. If you weren't expecting it, you can ignore this email.\n\n` +
    `— Mass Tort OS`;
  const html =
    `<p>You've been invited to join <strong>${safeFirm}</strong> on Mass Tort OS.</p>` +
    `<p>Set up your account below — <strong>${safeTo}</strong> will be your sign-in address:</p>` +
    `<p><a href="${link}">Accept your invitation</a></p>` +
    `<p>This invitation expires in 14 days. If you weren't expecting it, you can ignore this email.</p>` +
    `<p>— Mass Tort OS</p>`;
  try {
    await enqueueJob("send_workflow_email", { to, to_name: to, subject, html, text });
    logger.info({ to, firm: safeFirm }, "Firm invite email queued");
  } catch (err) {
    logger.error({ err, to }, "Failed to enqueue firm invite email");
  }
}
