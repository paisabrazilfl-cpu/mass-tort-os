// Regression test for blocker #16: GET /api/leads/:id/fax-results must
// return rows discoverable via EITHER the canonical lead_id FK OR the
// legacy filename pattern (because fax_results.lead_id is intentionally
// nullable and no enforced FK — per T001 "no enforced FK since legacy
// rows may dangle"). We exercise the same drizzle query the route
// builds rather than spinning up an HTTP layer; this keeps the test
// hermetic and pinned to the exact OR(eq lead_id, ilike source_file)
// contract that closes the architect finding.

import { test, after, before } from "node:test";
import assert from "node:assert/strict";
import { db, faxResultsTable } from "@workspace/db";
import { desc, eq, ilike, or, inArray } from "drizzle-orm";
import { buildFaxResultsLikePattern, FAX_SOURCE_FILE_TEMPLATE } from "../../lib/fax-results-matcher.js";

// Choose a synthetic lead id that will not collide with seeded fixtures.
const LEAD_ID = 9_321_046;
const ENV_NEW = "env-new-12345";
const ENV_LEGACY = "env-legacy-67890";

const insertedIds: number[] = [];

before(async () => {
  // Row A: new path — lead_id populated, source_file matches template.
  const a = await db
    .insert(faxResultsTable)
    .values({
      lead_id: LEAD_ID,
      source_file: FAX_SOURCE_FILE_TEMPLATE(LEAD_ID, ENV_NEW),
      vault_path: `/vault/test/${ENV_NEW}.pdf`,
    })
    .returning({ id: faxResultsTable.id });
  insertedIds.push(a[0]!.id);

  // Row B: legacy path — lead_id NULL, source_file still matches template
  // for this lead. The route must still return this row.
  const b = await db
    .insert(faxResultsTable)
    .values({
      lead_id: null,
      source_file: FAX_SOURCE_FILE_TEMPLATE(LEAD_ID, ENV_LEGACY),
      vault_path: `/vault/test/${ENV_LEGACY}.pdf`,
    })
    .returning({ id: faxResultsTable.id });
  insertedIds.push(b[0]!.id);
});

after(async () => {
  if (insertedIds.length === 0) return;
  await db.delete(faxResultsTable).where(inArray(faxResultsTable.id, insertedIds));
});

test("GET /leads/:id/fax-results returns BOTH lead_id-anchored and legacy filename-only rows", async () => {
  const pattern = buildFaxResultsLikePattern(LEAD_ID);
  const rows = await db
    .select()
    .from(faxResultsTable)
    .where(or(eq(faxResultsTable.lead_id, LEAD_ID), ilike(faxResultsTable.source_file, pattern)))
    .orderBy(desc(faxResultsTable.created_at));

  // Filter to just the two we inserted (the LEAD_ID is synthetic so this
  // should match only our two rows, but be defensive against any other
  // tests inserting under the same id).
  const ours = rows.filter((r) => insertedIds.includes(r.id));
  assert.equal(ours.length, 2, "must return both new-path and legacy-path rows");

  const sourceFiles = ours.map((r) => r.source_file).sort();
  assert.equal(sourceFiles[0], FAX_SOURCE_FILE_TEMPLATE(LEAD_ID, ENV_LEGACY));
  assert.equal(sourceFiles[1], FAX_SOURCE_FILE_TEMPLATE(LEAD_ID, ENV_NEW));

  const withLeadId = ours.find((r) => r.lead_id === LEAD_ID);
  const withoutLeadId = ours.find((r) => r.lead_id === null);
  assert.ok(withLeadId, "row anchored by lead_id must be returned");
  assert.ok(withoutLeadId, "legacy row with NULL lead_id but matching source_file must be returned");
});

test("buildFaxResultsLikePattern guards against prefix collisions in the route query", async () => {
  // Insert a row for a different lead whose id starts with LEAD_ID's
  // digits but is NOT the same lead — proves the trailing `_env_` literal
  // in the pattern prevents 932/93 cross-talk.
  const otherLeadId = LEAD_ID * 10 + 1; // e.g. 93210461
  const otherInsert = await db
    .insert(faxResultsTable)
    .values({
      lead_id: null,
      source_file: FAX_SOURCE_FILE_TEMPLATE(otherLeadId, "env-prefix-collision"),
      vault_path: "/vault/test/prefix-collision.pdf",
    })
    .returning({ id: faxResultsTable.id });
  const collisionId = otherInsert[0]!.id;

  try {
    const pattern = buildFaxResultsLikePattern(LEAD_ID);
    const rows = await db
      .select()
      .from(faxResultsTable)
      .where(or(eq(faxResultsTable.lead_id, LEAD_ID), ilike(faxResultsTable.source_file, pattern)));
    const collided = rows.find((r) => r.id === collisionId);
    assert.equal(collided, undefined, "must not match a different lead whose id shares a prefix");
  } finally {
    await db.delete(faxResultsTable).where(eq(faxResultsTable.id, collisionId));
  }
});
