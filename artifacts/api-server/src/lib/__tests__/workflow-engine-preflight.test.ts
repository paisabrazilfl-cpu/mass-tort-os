import { describe, test, before, after } from "node:test";
import assert from "node:assert/strict";
import { db, leadsTable, jobQueueTable, documentTemplatesTable, auditLogTable } from "@workspace/db";
import { and, eq, gt, inArray, sql } from "drizzle-orm";
import { enqueueLeadApprovalPackets } from "../workflow-engine";
import { encryptLeadFields } from "../encryption";

const NS = `wf-preflight-${Date.now()}`;
const TORT = `${NS}-tort`;

const createdLeadIds: number[] = [];
const createdTemplateIds: number[] = [];
const createdJobIds: number[] = [];

async function seedLead(email: string | null): Promise<number> {
  const base = encryptLeadFields({
    name: "Preflight Fixture",
    email,
    phone: "5550000000",
    tort_type: TORT,
    status: "qualified",
  } as Record<string, unknown>);
  const [row] = await db
    .insert(leadsTable)
    .values(base as typeof leadsTable.$inferInsert)
    .returning({ id: leadsTable.id });
  if (!row) throw new Error("seedLead: insert returned no row");
  createdLeadIds.push(row.id);
  return row.id;
}

async function seedTemplate(): Promise<number> {
  const [row] = await db
    .insert(documentTemplatesTable)
    .values({
      name: `${NS}-template`,
      template_type: "retainer",
      content: "test",
      active: true,
    } as typeof documentTemplatesTable.$inferInsert)
    .returning({ id: documentTemplatesTable.id });
  if (!row) throw new Error("seedTemplate: insert returned no row");
  createdTemplateIds.push(row.id);
  return row.id;
}

describe("enqueueLeadApprovalPackets — no-signer-email pre-flight", () => {
  before(async () => {
    await seedTemplate();
  });

  after(async () => {
    // CRITICAL: only delete rows this test created. Never use a permissive
    // WHERE clause like `gt(id, 0)` here — that would wipe production-like
    // data in the shared dev DB.
    if (createdLeadIds.length > 0) {
      // Jobs we know we created OR jobs whose payload references one of our test leads.
      await db.delete(jobQueueTable).where(
        sql`payload->>'lead_id' IN (${sql.join(createdLeadIds.map((id) => sql`${String(id)}`), sql`, `)})`,
      );
      if (createdJobIds.length > 0) {
        await db.delete(jobQueueTable).where(inArray(jobQueueTable.id, createdJobIds));
      }
      await db.delete(auditLogTable).where(
        and(
          eq(auditLogTable.entity_type, "lead"),
          inArray(auditLogTable.entity_id, createdLeadIds.map(String)),
        ),
      );
      await db.delete(leadsTable).where(inArray(leadsTable.id, createdLeadIds));
    }
    if (createdTemplateIds.length > 0) {
      await db.delete(documentTemplatesTable).where(inArray(documentTemplatesTable.id, createdTemplateIds));
    }
  });

  test("lead with NULL email enqueues ZERO send_esign_packet jobs and audit-logs no_signer_email", async () => {
    const leadId = await seedLead(null);
    const maxBefore = (await db
      .select({ id: jobQueueTable.id })
      .from(jobQueueTable)
      .orderBy(jobQueueTable.id)
    ).reduce((m, r) => Math.max(m, r.id), 0);

    const result = await enqueueLeadApprovalPackets(leadId);

    assert.equal(result.enqueued.length, 0, "no jobs should be enqueued for a no-email lead");
    assert.ok(result.skipped.length >= 1, "at least one template should be marked skipped");
    assert.ok(
      result.skipped.every((s) => s.reason === "no_signer_email"),
      "every skip reason should be no_signer_email",
    );

    const newJobs = await db
      .select({ id: jobQueueTable.id, job_type: jobQueueTable.job_type })
      .from(jobQueueTable)
      .where(gt(jobQueueTable.id, maxBefore));
    assert.equal(
      newJobs.filter((j) => j.job_type === "send_esign_packet").length,
      0,
      "no send_esign_packet job rows should exist",
    );

    const audits = await db
      .select({ action: auditLogTable.action, details: auditLogTable.details })
      .from(auditLogTable)
      .where(eq(auditLogTable.entity_id, String(leadId)));
    const skipped = audits.find(
      (a) => a.action === "approval_dispatch_skipped"
        && (a.details as Record<string, unknown> | null)?.reason === "no_signer_email",
    );
    assert.ok(skipped, "audit_log should record approval_dispatch_skipped with no_signer_email");
  });

  test("lead WITH email is allowed past the pre-flight and reaches the per-template loop", async () => {
    const leadId = await seedLead("preflight-test@example.com");
    const result = await enqueueLeadApprovalPackets(leadId);
    assert.ok(
      result.skipped.every((s) => s.reason !== "no_signer_email"),
      "no template should be skipped with no_signer_email when email is present",
    );
  });
});
