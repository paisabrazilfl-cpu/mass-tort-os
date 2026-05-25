import { db, vendorsTable } from "@workspace/db";
import { isNull, or } from "drizzle-orm";
import { randomBytes } from "node:crypto";

const rows = await db
  .select({ id: vendorsTable.id, portal_token: vendorsTable.portal_token, internal_code: vendorsTable.internal_code })
  .from(vendorsTable)
  .where(or(isNull(vendorsTable.portal_token), isNull(vendorsTable.internal_code)));

console.log(`Backfilling ${rows.length} vendors...`);

for (const row of rows) {
  const token = row.portal_token ?? randomBytes(16).toString("hex");
  const code = row.internal_code ?? `V-${String(row.id).padStart(3, "0")}`;
  await db
    .update(vendorsTable)
    .set({
      portal_token: token,
      internal_code: code,
    })
    .where(isNull(vendorsTable.portal_token));
  console.log(`  Vendor ${row.id} → ${code}`);
}

console.log("Done.");
process.exit(0);
