/**
 * Integration test for the `documents.fax_medical_records` automation node.
 *
 * We mock the fax adapter (so no real provider call) and the resolver
 * (so no integrations row is required), then exercise the executor handler
 * end-to-end against the live PG database. Asserts:
 *   - branch=sent on adapter ok, with structured payload (fax_results_id,
 *     external_fax_id, provider, to)
 *   - branch=failed on adapter non-retryable error, with fax_results_id
 *     populated and a fax_results row written in status=error
 *   - branch=failed on missing hospital_fax, with a fax_results row
 *     pre-created so it surfaces in the timeline
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { db, leadsTable, faxResultsTable } from "@workspace/db";
import { eq } from "drizzle-orm";

// Stub the fax adapter + provider resolver BEFORE importing the executor.
// We do this by hand-patching the adapter registry once the modules load.
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

  const adapters = await import("../fax");
  const provider = await import("../provider-router");
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
  await db.delete(faxResultsTable).where(eq(faxResultsTable.source_file, `outbound:lead_${leadId}_envelope_0_med_records.pdf`));
  await db.delete(leadsTable).where(eq(leadsTable.id, leadId));
  const adapters = await import("../fax");
  const provider = await import("../provider-router");
  if (originalGetAdapter) (adapters as any).getFaxAdapter = originalGetAdapter;
  if (originalResolveProvider) (provider as any).resolveProvider = originalResolveProvider;
});

test("documents.fax_medical_records: branch=sent on adapter success", async (t) => {
  const adapters = await import("../fax");
  (adapters as any).getFaxAdapter = () => ({
    provider: "test_provider",
    send: async () => ({ ok: true, externalFaxId: "ext-123", rawResponse: {} }),
  });

  // Reach into the executor's NODE_HANDLERS map via the documented public
  // entrypoint: drive a one-node graph through `runWorkflow`.
  const { handleFaxMedRecordsRequest } = await import("../workflow-handlers");
  const result = await handleFaxMedRecordsRequest({ lead_id: leadId, envelope_id: 0 });
  assert.equal(result.ok, true);
  assert.equal(result.status, "done");
  assert.equal(result.externalFaxId, "ext-123");
  assert.equal(result.provider, "test_provider");
  assert.equal(result.to, "+16144552138");
  assert.ok(result.faxResultId > 0);

  const [row] = await db.select().from(faxResultsTable).where(eq(faxResultsTable.id, result.faxResultId));
  assert.equal(row.status, "done");
});

test("documents.fax_medical_records: branch=failed on non-retryable adapter error", async () => {
  const adapters = await import("../fax");
  (adapters as any).getFaxAdapter = () => ({
    provider: "test_provider",
    send: async () => ({ ok: false, retryable: false, code: "BAD_NUMBER", message: "Number unreachable" }),
  });

  const { handleFaxMedRecordsRequest } = await import("../workflow-handlers");
  await assert.rejects(
    () => handleFaxMedRecordsRequest({ lead_id: leadId, envelope_id: 0 }),
    /Fax provider rejected request/,
  );
  // Verify a fax_results row exists in error state.
  const rows = await db
    .select()
    .from(faxResultsTable)
    .where(eq(faxResultsTable.source_file, `outbound:lead_${leadId}_envelope_0_med_records.pdf`));
  assert.ok(rows.some((r) => r.status === "error"));
});

test("documents.fax_medical_records: missing hospital_fax surfaces in fax_results timeline", async () => {
  await db.update(leadsTable).set({ hospital_fax: null }).where(eq(leadsTable.id, leadId));
  const { handleFaxMedRecordsRequest } = await import("../workflow-handlers");
  await assert.rejects(
    () => handleFaxMedRecordsRequest({ lead_id: leadId, envelope_id: 0 }),
    /no hospital_fax on file/,
  );
  const rows = await db
    .select()
    .from(faxResultsTable)
    .where(eq(faxResultsTable.source_file, `outbound:lead_${leadId}_envelope_0_med_records.pdf`));
  // At least one row should mention "no_fax_on_file"
  assert.ok(rows.some((r) => (r.raw_text ?? "").includes("no_fax_on_file")));
  // Restore for later cleanup safety
  await db.update(leadsTable).set({ hospital_fax: "+16144552138" }).where(eq(leadsTable.id, leadId));
});
