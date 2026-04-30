import { describe, test, before, after } from "node:test";
import assert from "node:assert/strict";
import { db, leadsTable } from "@workspace/db";
import { eq, inArray } from "drizzle-orm";
import { encryptLeadFields } from "../encryption";
import { findExistingLeadForIntake } from "../lead-dedup";

/**
 * Behavioral contract for the shared dedup helper that backs the
 * "one signee per (human, tort)" rule.
 *
 * Each fixture lead uses a unique tort_type label so the tests don't
 * collide with each other or with real data. Cleanup in `after()`
 * removes only the rows we created.
 */
const NS = `dedup-test-${Date.now()}`;
const TORT_A = `${NS}-tort-A`;
const TORT_B = `${NS}-tort-B`;
const createdIds: number[] = [];

async function seedLead(values: Partial<typeof leadsTable.$inferInsert>): Promise<number> {
  const [row] = await db
    .insert(leadsTable)
    .values({
      name: values.name ?? "Fixture Person",
      tort_type: values.tort_type ?? TORT_A,
      status: values.status ?? "web_form_intake",
      ...values,
    } as typeof leadsTable.$inferInsert)
    .returning({ id: leadsTable.id });
  if (!row) throw new Error("seedLead: insert returned no row");
  createdIds.push(row.id);
  return row.id;
}

describe("findExistingLeadForIntake", () => {
  before(async () => {
    // Sanity: a global cleanup of any leftover fixtures from a previous
    // crashed run that share our namespace prefix.
    const stragglers = await db
      .select({ id: leadsTable.id })
      .from(leadsTable)
      .where(inArray(leadsTable.tort_type, [TORT_A, TORT_B]))
      .limit(100);
    if (stragglers.length > 0) {
      await db.delete(leadsTable).where(
        inArray(
          leadsTable.id,
          stragglers.map((r) => r.id),
        ),
      );
    }
  });

  after(async () => {
    if (createdIds.length > 0) {
      await db.delete(leadsTable).where(inArray(leadsTable.id, createdIds));
    }
  });

  test("returns null when nothing matches", async () => {
    const result = await findExistingLeadForIntake({
      email: `nobody-${Date.now()}@example.org`,
      phone: null,
      tortType: TORT_A,
    });
    assert.equal(result, null);
  });

  test("returns null when tortType is empty (global dedup must not happen)", async () => {
    const id = await seedLead({
      email: "shared@example.org",
      tort_type: TORT_A,
    });
    const result = await findExistingLeadForIntake({
      email: "shared@example.org",
      phone: null,
      tortType: "",
    });
    assert.equal(
      result,
      null,
      `must not match across all torts; instead matched lead ${id}`,
    );
  });

  test("matches by email (case-insensitive) within the same tort", async () => {
    const id = await seedLead({
      email: "Jane.Doe@Example.com",
      tort_type: TORT_A,
    });
    const result = await findExistingLeadForIntake({
      email: "jane.doe@example.com",
      phone: null,
      tortType: TORT_A,
    });
    assert.deepEqual(result, { leadId: id, matchedBy: "email" });
  });

  test("does NOT match the same email across a different tort", async () => {
    await seedLead({ email: "cross@example.com", tort_type: TORT_A });
    const result = await findExistingLeadForIntake({
      email: "cross@example.com",
      phone: null,
      tortType: TORT_B,
    });
    assert.equal(
      result,
      null,
      "per-tort scoping is the product invariant; this would create cross-tort merges",
    );
  });

  test("matches by encrypted phone when no email match (production AAD format)", async () => {
    const phoneDigits = "5125551234";
    // CRITICAL: production goes through encryptLeadFields(...), which
    // calls encrypt(value, "phone", undefined) under the hood and
    // therefore tags the ciphertext with the "phone" AAD. Use the same
    // helper here so we exercise the AAD-aware decrypt path. An earlier
    // version of this test used `encrypt(phoneDigits)` with no field
    // name and silently masked a real production bug (architect review).
    const { phone: encryptedPhone } = encryptLeadFields({ phone: phoneDigits });
    const id = await seedLead({
      email: "phoneonly@example.com",
      phone: encryptedPhone,
      tort_type: TORT_A,
    });
    const result = await findExistingLeadForIntake({
      // intentionally no email match
      email: "different@example.com",
      // submitter typed it formatted differently
      phone: "(512) 555-1234",
      tortType: TORT_A,
    });
    assert.deepEqual(result, { leadId: id, matchedBy: "phone" });
  });

  test("email match wins over phone match (precedence)", async () => {
    const phoneDigits = "5125559999";
    // Same reason as the prior test — go through the production helper
    // so the ciphertext carries the AAD the dedup helper expects.
    const { phone: encryptedPhone } = encryptLeadFields({ phone: phoneDigits });
    const phoneLead = await seedLead({
      email: "owner-of-phone@example.com",
      phone: encryptedPhone,
      tort_type: TORT_A,
    });
    const emailLead = await seedLead({
      email: "submitter@example.com",
      tort_type: TORT_A,
    });
    const result = await findExistingLeadForIntake({
      email: "submitter@example.com",
      phone: "5125559999",
      tortType: TORT_A,
    });
    assert.deepEqual(
      result,
      { leadId: emailLead, matchedBy: "email" },
      `expected email match on lead ${emailLead}, not phone match on ${phoneLead}`,
    );
  });

  test("a phone shorter than 10 digits is ignored (avoids false positives)", async () => {
    const result = await findExistingLeadForIntake({
      email: null,
      phone: "555-1234",
      tortType: TORT_A,
    });
    assert.equal(result, null);
  });
});
