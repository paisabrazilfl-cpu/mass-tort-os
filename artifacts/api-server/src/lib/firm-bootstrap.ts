import crypto from "crypto";
import { db } from "@workspace/db";
import { firmsTable, usersTable, apiKeysTable } from "@workspace/db";
import { and, eq, isNull, sql } from "drizzle-orm";
import { logger } from "./logger";
import { hashApiKey, API_KEY_PREFIX } from "./api-keys";

async function hashPassword(password: string): Promise<string> {
  const salt = crypto.randomBytes(16).toString("hex");
  const key: Buffer = await new Promise((resolve, reject) =>
    crypto.scrypt(password, salt, 64, (err, k) =>
      err ? reject(err) : resolve(k as Buffer),
    ),
  );
  return `${salt}:${key.toString("hex")}`;
}

const DEFAULT_FIRM_SLUG = "default";
const DEFAULT_FIRM_NAME = "Default Firm";

export interface SeedDefaultFirmResult {
  firm_id: number;
  inserted: boolean;
  users_backfilled: number;
}

export async function seedDefaultFirm(): Promise<SeedDefaultFirmResult> {
  const existing = await db
    .select({ id: firmsTable.id })
    .from(firmsTable)
    .where(eq(firmsTable.slug, DEFAULT_FIRM_SLUG))
    .limit(1);

  let firmId: number;
  let inserted = false;

  if (existing.length > 0 && existing[0]) {
    firmId = existing[0].id;
  } else {
    const [row] = await db
      .insert(firmsTable)
      .values({
        name: DEFAULT_FIRM_NAME,
        slug: DEFAULT_FIRM_SLUG,
        // The default firm is the owner's free-tier workspace. The
        // subscriptionGateMiddleware in lib/subscription-gate.ts ALREADY
        // bypasses gating when no stripe integration row exists, but the
        // CRM's BillingBanner only checks the stored status — so an
        // "inactive" seed shows a red banner on first login. Seed as
        // "active" so the owner doesn't see a billing warning on a
        // self-hosted deploy that has no Stripe set up. If Stripe is
        // later configured and a real subscription created, the stripe
        // webhook handler is the source of truth and will overwrite this.
        subscription_status: "active",
      })
      .returning({ id: firmsTable.id });
    if (!row) {
      throw new Error("seedDefaultFirm: insert returned no row");
    }
    firmId = row.id;
    inserted = true;
  }

  // Idempotent: existing default-firm rows from an older seed (or other
  // deploys that wrote "inactive") get flipped to "active" so the
  // BillingBanner doesn't keep showing after this commit ships.
  await db
    .update(firmsTable)
    .set({ subscription_status: "active" })
    .where(and(eq(firmsTable.slug, DEFAULT_FIRM_SLUG), eq(firmsTable.subscription_status, "inactive")));

  const result = await db
    .update(usersTable)
    .set({ firm_id: firmId })
    .where(isNull(usersTable.firm_id))
    .returning({ id: usersTable.id });

  const usersBackfilled = result.length;

  logger.info(
    { firm_id: firmId, inserted, users_backfilled: usersBackfilled },
    "Default firm seed",
  );

  return { firm_id: firmId, inserted, users_backfilled: usersBackfilled };
}

export async function getDefaultFirmId(): Promise<number | null> {
  const rows = await db
    .select({ id: firmsTable.id })
    .from(firmsTable)
    .where(eq(firmsTable.slug, DEFAULT_FIRM_SLUG))
    .limit(1);
  return rows[0]?.id ?? null;
}

/**
 * One-shot backfill for the new email-verification gate (Task #56).
 *
 * Pre-existing user rows were created before `email_verified_at` existed
 * and would otherwise be locked out by the new login check. We mark
 * them verified using their original `created_at` as the timestamp so
 * the audit trail stays honest ("verified at the time the row was
 * created — implicitly, by the prior code path").
 *
 * The predicate excludes rows that have a verification token hash
 * pending. Those are genuinely-new pending registrations and must NOT
 * be auto-verified — they have to consume their email link. Combined
 * with the IS NULL guard on email_verified_at, the statement is fully
 * idempotent: once a row is verified it never matches again, and once
 * a token is issued the row is excluded until consumption clears the
 * hash.
 */
export async function backfillEmailVerifiedAt(): Promise<{ rows_updated: number }> {
  const result = await db.execute(sql`
    UPDATE mtos_users
    SET email_verified_at = COALESCE(email_verified_at, created_at)
    WHERE email_verified_at IS NULL
      AND email_verification_token_hash IS NULL
    RETURNING id
  `);
  const rowsUpdated = (result as unknown as { rows?: unknown[] }).rows?.length ?? 0;
  if (rowsUpdated > 0) {
    logger.info({ rows_updated: rowsUpdated }, "Email verification backfill: marked legacy users verified");
  }
  return { rows_updated: rowsUpdated };
}

/**
 * One-time super-admin bootstrap.
 *
 * Runs on every startup but is a no-op unless SEED_ADMIN_EMAIL and
 * SEED_ADMIN_PASSWORD are both set.  When set it upserts a single
 * super_admin row so operators can gain initial access to a fresh
 * production database without needing direct DB access.
 *
 * Remove (or unset) the env vars after first login.
 */
export async function seedSuperAdmin(): Promise<{ skipped: boolean; created: boolean; updated: boolean }> {
  const email = process.env["SEED_ADMIN_EMAIL"]?.trim();
  const password = process.env["SEED_ADMIN_PASSWORD"]?.trim();

  if (!email || !password) {
    return { skipped: true, created: false, updated: false };
  }

  const firmRows = await db
    .select({ id: firmsTable.id })
    .from(firmsTable)
    .where(eq(firmsTable.slug, DEFAULT_FIRM_SLUG))
    .limit(1);
  const firmId = firmRows[0]?.id;
  if (!firmId) {
    logger.warn("seedSuperAdmin: default firm not found — skipping (run seedDefaultFirm first)");
    return { skipped: true, created: false, updated: false };
  }

  const existing = await db
    .select({ id: usersTable.id })
    .from(usersTable)
    .where(eq(usersTable.email, email))
    .limit(1);

  const passwordHash = await hashPassword(password);
  const now = new Date();

  if (existing.length === 0) {
    await db.insert(usersTable).values({
      email,
      name: "Super Admin",
      role: "super_admin",
      firm_id: firmId,
      password_hash: passwordHash,
      mfa_enabled: false,
      email_verified_at: now,
    });
    logger.info({ email }, "seedSuperAdmin: created super_admin user");
    return { skipped: false, created: true, updated: false };
  }

  await db
    .update(usersTable)
    .set({
      password_hash: passwordHash,
      role: "super_admin",
      mfa_enabled: false,
      email_verified_at: sql`COALESCE(email_verified_at, ${now})`,
    })
    .where(eq(usersTable.email, email));
  logger.info({ email }, "seedSuperAdmin: updated existing user to super_admin");
  return { skipped: false, created: false, updated: true };
}

const MASTER_KEY_NAME = "MASTER";

/**
 * Master API key bootstrap.
 *
 * Runs on every startup; a no-op unless MTOS_MASTER_API_KEY is set. When set,
 * it upserts a single api_keys row whose SHA-256 hash matches that value,
 * carrying the wildcard scope "*" and owned by the super-admin user. Any
 * caller that sends `Authorization: Bearer <MTOS_MASTER_API_KEY>` then has
 * full programmatic access to every MTOS API route — this is the "API in"
 * master credential.
 *
 * The value MUST start with the `mtos_` prefix so the auth middleware routes
 * it down the API-key path. It flows through the SAME hashed-storage, scope-
 * check, per-request audit, and revoke machinery as any minted key — the only
 * difference is that the operator chooses the plaintext (and treats it as
 * permanent) instead of it being randomly minted and shown once.
 *
 * To retire the key: unset MTOS_MASTER_API_KEY and revoke the MASTER row in
 * the API Keys admin page (a still-set env var would otherwise re-seed it on
 * the next boot).
 */
export async function seedMasterApiKey(): Promise<{ skipped: boolean; created: boolean; updated: boolean }> {
  const masterKey = process.env["MTOS_MASTER_API_KEY"]?.trim();
  if (!masterKey) {
    return { skipped: true, created: false, updated: false };
  }
  if (!masterKey.startsWith(API_KEY_PREFIX)) {
    logger.warn(
      `seedMasterApiKey: MTOS_MASTER_API_KEY must start with "${API_KEY_PREFIX}" — skipping. The auth middleware only routes ${API_KEY_PREFIX}-prefixed bearer tokens to the API-key path.`,
    );
    return { skipped: true, created: false, updated: false };
  }
  if (masterKey.length < API_KEY_PREFIX.length + 24) {
    logger.warn("seedMasterApiKey: MTOS_MASTER_API_KEY is too short — refusing to seed a weak master credential.");
    return { skipped: true, created: false, updated: false };
  }

  // The master key is owned by — and inherits the permissions of — the
  // super-admin. Pick the lowest-id super_admin so the choice is stable
  // across reboots.
  const [admin] = await db
    .select({ id: usersTable.id, firm_id: usersTable.firm_id })
    .from(usersTable)
    .where(eq(usersTable.role, "super_admin"))
    .orderBy(usersTable.id)
    .limit(1);
  if (!admin) {
    logger.warn("seedMasterApiKey: no super_admin user found — skipping (set SEED_ADMIN_EMAIL/PASSWORD and reboot).");
    return { skipped: true, created: false, updated: false };
  }

  const keyHash = hashApiKey(masterKey);
  const body = masterKey.slice(API_KEY_PREFIX.length);
  const keyPrefix = `${API_KEY_PREFIX}${body.slice(0, 8)}…`;

  const [existing] = await db
    .select({ id: apiKeysTable.id })
    .from(apiKeysTable)
    .where(and(eq(apiKeysTable.name, MASTER_KEY_NAME), eq(apiKeysTable.firm_id, admin.firm_id)))
    .limit(1);

  if (!existing) {
    await db.insert(apiKeysTable).values({
      name: MASTER_KEY_NAME,
      key_hash: keyHash,
      key_prefix: keyPrefix,
      scopes: ["*"],
      firm_id: admin.firm_id,
      created_by_user_id: admin.id,
    });
    logger.info({ firm_id: admin.firm_id }, "seedMasterApiKey: created MASTER api key (scope=*)");
    return { skipped: false, created: true, updated: false };
  }

  // Idempotent refresh: re-point the row at the current env value, restore
  // the wildcard scope, and clear any prior revocation.
  await db
    .update(apiKeysTable)
    .set({
      key_hash: keyHash,
      key_prefix: keyPrefix,
      scopes: ["*"],
      revoked_at: null,
      created_by_user_id: admin.id,
    })
    .where(eq(apiKeysTable.id, existing.id));
  logger.info(
    { firm_id: admin.firm_id, api_key_id: existing.id },
    "seedMasterApiKey: refreshed MASTER api key (scope=*)",
  );
  return { skipped: false, created: false, updated: true };
}
