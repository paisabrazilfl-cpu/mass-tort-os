import { db } from "@workspace/db";
import { firmsTable, usersTable } from "@workspace/db";
import { eq, isNull } from "drizzle-orm";
import { sql } from "drizzle-orm";
import { logger } from "./logger";

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
        subscription_status: "inactive",
      })
      .returning({ id: firmsTable.id });
    if (!row) {
      throw new Error("seedDefaultFirm: insert returned no row");
    }
    firmId = row.id;
    inserted = true;
  }

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
