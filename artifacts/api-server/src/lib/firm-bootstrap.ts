import { db } from "@workspace/db";
import { firmsTable, usersTable } from "@workspace/db";
import { eq, isNull } from "drizzle-orm";
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
