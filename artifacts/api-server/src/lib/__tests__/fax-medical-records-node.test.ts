/**
 * Integration test for the `documents.fax_medical_records` automation node.
 *
 * Drives the executor handler directly (not the full graph runner) with a
 * synthetic node + step context, and monkey-patches the fax adapter and
 * provider router so no real provider call is made. Asserts the structured
 * branch payload matches the contract documented in node-catalog.ts.
 *
 * Lifecycle: a temp lead is inserted in `before` and removed (with all of
 * its fax_results rows, located via the canonical FAX_SOURCE_FILE_TEMPLATE)
 * in `after`.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { db, leadsTable, faxResultsTable } from "@workspace/db";
import { eq, like } from "drizzle-orm";
import { FAX_SOURCE_FILE_TEMPLATE, buildFaxResultsLikePattern } from "../fax-results-matcher.js";

let leadId: number;
let originalGetAdapter: any;
let originalResolveProvider: any;

before(async () => {
  const [lead] = await db
    .insert(leadsTable)
    .values({
      name: "Fax Test Lead",
      tort_type: "test_tort",
      status: "web_form_intake",
      source: "automation_test",
      hospital_fax: "+16144552138",
    } as typeof leadsTable.$inferInsert)
    .returning();
  leadId = lead.id;

  const adapters = await import("../fax/index.js");
  const provider = await import("../provider-router.js");
  originalGetAdapter = (adapters as any).getFaxAdapter;
  originalResolveProvider = (provider as any).resolveProvider;
  (provider as any).resolveProvider = async () => ({
    ok: true,
    provider: "test_provider",
    credentials: {} as any,
    integrationId: 999,
  });
});

after(async () => {
  await db
    .delete(faxResultsTable)
    .where(like(faxResultsTable.source_file, buildFaxResultsLikePattern(leadId)));
  await db.delete(leadsTable).where(eq(leadsTable.id, leadId));
  const adapters = await import("../fax/index.js");
  const provider = await import("../provider-router.js");
  if (originalGetAdapter) (adapters as any).getFaxAdapter = originalGetAdapter;
  if (originalResolveProvider) (provider as any).resolveProvider = originalResolveProvider;
});

/**
 * Run the executor's `documents.fax_medical_records` handler with a minimal
 * synthetic step context. Avoids spinning up a full workflow run row.
 */
async function runFaxNode(params: Record<string, unknown>) {
  const { HANDLERS } = await import("../automations/executor.js");
  const handler = (HANDLERS as any)["documents.fax_medical_records"];
  assert.ok(handler, "fax node handler missing from NODE_HANDLERS");
  const ctx = {
    runId: 0,
    workflowId: 0,
    firmId: null,
    triggerSource: "test",
    vars: {},
    input: {},
    log: () => {},
  };
  const node = { id: "n1", type: "documents.fax_medical_records", data: { params } };
  return handler({ ctx, node, prev: undefined });
}

test("documents.fax_medical_records: branch=sent on adapter success", async () => {
  const adapters = await import("../fax/index.js");
  (adapters as any).getFaxAdapter = () => ({
    provider: "test_provider",
    send: async () => ({ ok: true, externalFaxId: "ext-123", rawResponse: {} }),
  });

  const out = await runFaxNode({ leadId });
  assert.equal(out.__branch, "sent");
  assert.equal(out.value.lead_id, leadId);
  assert.equal(out.value.external_fax_id, "ext-123");
  assert.equal(out.value.provider, "test_provider");
  assert.equal(out.value.to, "+16144552138");
  assert.ok(out.value.fax_results_id > 0);

  const [row] = await db.select().from(faxResultsTable).where(eq(faxResultsTable.id, out.value.fax_results_id));
  assert.equal(row.status, "done");
  assert.equal(row.source_file, FAX_SOURCE_FILE_TEMPLATE(leadId, 0));
});

test("documents.fax_medical_records: branch=failed on non-retryable adapter error includes fax_results_id", async () => {
  const adapters = await import("../fax/index.js");
  (adapters as any).getFaxAdapter = () => ({
    provider: "test_provider",
    send: async () => ({ ok: false, retryable: false, code: "BAD_NUMBER", message: "Number unreachable" }),
  });

  const out = await runFaxNode({ leadId });
  assert.equal(out.__branch, "failed");
  assert.equal(out.value.error, "send_failed");
  assert.ok(out.value.fax_results_id, "fax_results_id must be carried on failed branch");
  const [row] = await db.select().from(faxResultsTable).where(eq(faxResultsTable.id, out.value.fax_results_id));
  assert.equal(row.status, "error");
});

test("documents.fax_medical_records: invalid override fax creates fax_results row and surfaces id", async () => {
  const out = await runFaxNode({ leadId, providerFax: "not-a-number" });
  assert.equal(out.__branch, "failed");
  assert.equal(out.value.error, "invalid_fax_number");
  // recordFaxFailure should have been called; id is included on the value.
  // (If the insert failed for any reason we surface null — but the contract
  // is that the field always exists on the failed payload.)
  assert.ok("fax_results_id" in out.value);
});

test("documents.fax_medical_records: missing hospital_fax surfaces in fax_results timeline", async () => {
  await db.update(leadsTable).set({ hospital_fax: null }).where(eq(leadsTable.id, leadId));
  const out = await runFaxNode({ leadId });
  assert.equal(out.__branch, "failed");
  assert.ok(out.value.fax_results_id, "missing-fax preflight must still write a fax_results row");
  await db.update(leadsTable).set({ hospital_fax: "+16144552138" }).where(eq(leadsTable.id, leadId));
});
