// Integration tests for the pipeline ORCHESTRATION helpers that the webhooks
// and CRM callbacks call (applyBackgroundCheckVerdict, applyMedRecordsReceived).
// These prove the two acceptance criteria a webhook depends on:
//   1. a single verdict produces the expected event TRAIL and final status, and
//   2. replaying the same verdict (same keySuffix == vendor event id) is a no-op.
//
// Like pipeline-state-machine.test.ts these hit the shared dev DB, so every
// synthetic lead + its pipeline_events are deleted in `after`. Emails fired by
// the bg-check stage are best-effort (never throw) and harmless without config.

import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import { db, leadsTable, pipelineEventsTable, firmsTable, auditLogTable, documentsTable } from "@workspace/db";
import { eq, asc, and } from "drizzle-orm";
import { PipelineStatus } from "../pipeline/state-machine.js";
import {
  startLeadPipeline,
  applyBackgroundCheckVerdict,
  applyDocumentsSigned,
  applyMedRecordsReceived,
  allDocumentsSigned,
} from "../pipeline/pipeline.js";
import {
  allRequiredDocumentsSigned,
  classifyEnvelopeDocType,
} from "../pipeline/doc-types.js";

// firm_id on pipeline_events is NULLABLE (mirrors lead_dispositions): the public
// intake path is firm-less and must flow. These orchestration fixtures still
// attach a firm_id so we also exercise the firm-recorded path; the separate
// pipeline-state-machine suite covers the firm-less case. One throwaway firm is
// created for the whole suite and cleaned up in `after`.
let firmId: number;
async function ensureFirm(): Promise<number> {
  if (firmId) return firmId;
  const slug = `test-pipeline-firm-${Date.now()}`;
  const [firm] = await db
    .insert(firmsTable)
    .values({ name: "Pipeline Test Firm", slug })
    .returning({ id: firmsTable.id });
  firmId = firm!.id;
  return firmId;
}

async function makeLead(name: string): Promise<number> {
  const fid = await ensureFirm();
  const [lead] = await db
    .insert(leadsTable)
    .values({ name, tort_type: "test_tort", firm_id: fid })
    .returning({ id: leadsTable.id });
  return lead!.id;
}

async function statusOf(leadId: number): Promise<string | null> {
  const [row] = await db
    .select({ ps: leadsTable.pipeline_status })
    .from(leadsTable)
    .where(eq(leadsTable.id, leadId));
  return row?.ps ?? null;
}

async function appliedTrail(leadId: number): Promise<string[]> {
  const rows = await db
    .select()
    .from(pipelineEventsTable)
    .where(eq(pipelineEventsTable.lead_id, leadId))
    .orderBy(asc(pipelineEventsTable.id));
  return rows.filter((r) => r.applied).map((r) => r.to_status);
}

describe("pipeline orchestration (webhook-level)", () => {
  const leadIds: number[] = [];

  after(async () => {
    for (const id of leadIds) {
      await db.delete(pipelineEventsTable).where(eq(pipelineEventsTable.lead_id, id));
      await db.delete(documentsTable).where(eq(documentsTable.lead_id, id));
      await db
        .delete(auditLogTable)
        .where(and(eq(auditLogTable.entity_type, "lead"), eq(auditLogTable.entity_id, String(id))));
      await db.delete(leadsTable).where(eq(leadsTable.id, id));
    }
    if (firmId) {
      await db.delete(firmsTable).where(eq(firmsTable.id, firmId));
    }
  });

  test("CLEAR verdict: single transition trail to INTAKE_SENT", async () => {
    const leadId = await makeLead("BG Clear Claimant");
    leadIds.push(leadId);
    await startLeadPipeline(leadId, { source: "test" });
    assert.equal(await statusOf(leadId), PipelineStatus.BG_CHECK_PENDING);

    const { transitions } = await applyBackgroundCheckVerdict(leadId, "CLEAR", {
      keySuffix: "evt-clear-1",
      source: "test",
    });
    assert.ok(transitions.every((t) => t.applied), "all CLEAR transitions applied");
    assert.equal(await statusOf(leadId), PipelineStatus.INTAKE_SENT);

    const trail = await appliedTrail(leadId);
    assert.deepEqual(trail, [
      PipelineStatus.NEW,
      PipelineStatus.BG_CHECK_PENDING,
      PipelineStatus.BG_CHECK_CLEAR,
      PipelineStatus.INTAKE_SENT,
    ]);
  });

  test("replaying the same CLEAR verdict is idempotent (no double-advance)", async () => {
    const leadId = await makeLead("BG Replay Claimant");
    leadIds.push(leadId);
    await startLeadPipeline(leadId, { source: "test" });

    await applyBackgroundCheckVerdict(leadId, "CLEAR", { keySuffix: "evt-dup", source: "test" });
    const trailAfterFirst = await appliedTrail(leadId);

    const { transitions } = await applyBackgroundCheckVerdict(leadId, "CLEAR", {
      keySuffix: "evt-dup",
      source: "test",
    });
    // Same event_key ⇒ every transition is a duplicate no-op.
    assert.ok(transitions.every((t) => !t.applied), "replay applied nothing");
    assert.ok(transitions.every((t) => t.outcome === "duplicate"));

    const trailAfterReplay = await appliedTrail(leadId);
    assert.deepEqual(trailAfterReplay, trailAfterFirst, "replay added no applied events");
    assert.equal(await statusOf(leadId), PipelineStatus.INTAKE_SENT);
  });

  test("FAILED verdict: trail to REJECTED (rejection path)", async () => {
    const leadId = await makeLead("BG Failed Claimant");
    leadIds.push(leadId);
    await startLeadPipeline(leadId, { source: "test" });

    await applyBackgroundCheckVerdict(leadId, "FAILED", { keySuffix: "evt-fail-1", source: "test" });
    assert.equal(await statusOf(leadId), PipelineStatus.REJECTED);

    const trail = await appliedTrail(leadId);
    assert.deepEqual(trail, [
      PipelineStatus.NEW,
      PipelineStatus.BG_CHECK_PENDING,
      PipelineStatus.BG_CHECK_FAILED,
      PipelineStatus.REJECTED,
    ]);
  });

  test("REVIEW verdict parks the lead (no transition)", async () => {
    const leadId = await makeLead("BG Review Claimant");
    leadIds.push(leadId);
    await startLeadPipeline(leadId, { source: "test" });

    const { transitions } = await applyBackgroundCheckVerdict(leadId, "REVIEW", {
      keySuffix: "evt-review",
      source: "test",
    });
    assert.equal(transitions.length, 0, "REVIEW emits no transitions");
    assert.equal(await statusOf(leadId), PipelineStatus.BG_CHECK_PENDING);
  });

  test("inbound med-recs from AWAITING_MED_RECS completes the pipeline", async () => {
    // Seed a lead directly at AWAITING_MED_RECS via the legal fan-out chain so
    // we exercise the inbound-fax orchestration in isolation.
    const leadId = await makeLead("Med Recs Claimant");
    leadIds.push(leadId);
    // Manually walk to AWAITING_MED_RECS through the state machine using the
    // pipeline's own applyMedRecordsReceived precondition: it expects the lead
    // at AWAITING_MED_RECS. Set it up via direct legal transitions.
    const { transitionLead } = await import("../pipeline/state-machine.js");
    const chain: Array<[string | null, string, string]> = [
      [null, PipelineStatus.NEW, "t_new"],
      [PipelineStatus.NEW, PipelineStatus.BG_CHECK_PENDING, "t_bgp"],
      [PipelineStatus.BG_CHECK_PENDING, PipelineStatus.BG_CHECK_CLEAR, "t_bgc"],
      [PipelineStatus.BG_CHECK_CLEAR, PipelineStatus.INTAKE_SENT, "t_is"],
      [PipelineStatus.INTAKE_SENT, PipelineStatus.INTAKE_COMPLETED, "t_ic"],
      [PipelineStatus.INTAKE_COMPLETED, PipelineStatus.NPI_PENDING, "t_np"],
      [PipelineStatus.NPI_PENDING, PipelineStatus.NPI_VERIFIED, "t_nv"],
      [PipelineStatus.NPI_VERIFIED, PipelineStatus.DOCS_SENT, "t_ds"],
      [PipelineStatus.DOCS_SENT, PipelineStatus.DOCS_SIGNED, "t_dsi"],
      [PipelineStatus.DOCS_SIGNED, PipelineStatus.HIPAA_FAXED, "t_hf"],
      [PipelineStatus.HIPAA_FAXED, PipelineStatus.AWAITING_MED_RECS, "t_amr"],
    ];
    for (const [, to, trig] of chain) {
      await transitionLead({ leadId, to: to as never, trigger: trig, eventKey: `${trig}-${leadId}`, source: "test" });
    }
    assert.equal(await statusOf(leadId), PipelineStatus.AWAITING_MED_RECS);

    await applyMedRecordsReceived(leadId, { keySuffix: "fax-1", source: "test" });
    assert.equal(await statusOf(leadId), PipelineStatus.COMPLETE);

    // Replaying the same inbound fax does not re-complete.
    const before = await appliedTrail(leadId);
    await applyMedRecordsReceived(leadId, { keySuffix: "fax-1", source: "test" });
    const afterTrail = await appliedTrail(leadId);
    assert.deepEqual(afterTrail, before, "duplicate inbound fax added no applied events");
  });

  test("fan-out advances to AWAITING_MED_RECS when HIPAA was faxed BEFORE the final (non-HIPAA) signature", async () => {
    // Regression for the ordering bug: the HIPAA fax dispatch is driven by the
    // HIPAA envelope being signed (onEnvelopeSigned writes `fax_request_enqueued`).
    // If a NON-HIPAA document is the last signature that completes the packet,
    // the current-event `hipaaFaxed` flag is false — yet the fax already went out
    // earlier. The persisted-audit signal must still carry the lead through.
    const leadId = await makeLead("HIPAA First Claimant");
    leadIds.push(leadId);
    const { transitionLead } = await import("../pipeline/state-machine.js");
    const chain: Array<[string, string]> = [
      [PipelineStatus.NEW, "t_new"],
      [PipelineStatus.BG_CHECK_PENDING, "t_bgp"],
      [PipelineStatus.BG_CHECK_CLEAR, "t_bgc"],
      [PipelineStatus.INTAKE_SENT, "t_is"],
      [PipelineStatus.INTAKE_COMPLETED, "t_ic"],
      [PipelineStatus.NPI_PENDING, "t_np"],
      [PipelineStatus.NPI_VERIFIED, "t_nv"],
    ];
    for (const [to, trig] of chain) {
      await transitionLead({ leadId, to: to as never, trigger: trig, eventKey: `${trig}-${leadId}`, source: "test" });
    }
    assert.equal(await statusOf(leadId), PipelineStatus.NPI_VERIFIED);

    // Simulate the HIPAA fax having been dispatched earlier (persisted audit).
    await db.insert(auditLogTable).values({
      entity_type: "lead",
      entity_id: String(leadId),
      action: "fax_request_enqueued",
      details: { envelope_id: 1, job_id: 1, target_fax: "+15551234567" },
    });

    // Final signature completes the packet but is NOT the HIPAA doc, so the
    // current-event flag is false. Persisted signal must carry it through.
    await applyDocumentsSigned(leadId, { keySuffix: "final-sig", source: "test", hipaaFaxed: false });
    assert.equal(await statusOf(leadId), PipelineStatus.AWAITING_MED_RECS);

    const trail = await appliedTrail(leadId);
    assert.ok(trail.includes(PipelineStatus.HIPAA_FAXED), "HIPAA_FAXED recorded from persisted signal");
    assert.ok(trail.includes(PipelineStatus.AWAITING_MED_RECS), "advanced to AWAITING_MED_RECS");
  });

  test("fan-out PARKS at DOCS_SIGNED when no HIPAA fax has been dispatched (honest, not over-advanced)", async () => {
    const leadId = await makeLead("No Fax Claimant");
    leadIds.push(leadId);
    const { transitionLead } = await import("../pipeline/state-machine.js");
    const chain: Array<[string, string]> = [
      [PipelineStatus.NEW, "t_new"],
      [PipelineStatus.BG_CHECK_PENDING, "t_bgp"],
      [PipelineStatus.BG_CHECK_CLEAR, "t_bgc"],
      [PipelineStatus.INTAKE_SENT, "t_is"],
      [PipelineStatus.INTAKE_COMPLETED, "t_ic"],
      [PipelineStatus.NPI_PENDING, "t_np"],
      [PipelineStatus.NPI_VERIFIED, "t_nv"],
    ];
    for (const [to, trig] of chain) {
      await transitionLead({ leadId, to: to as never, trigger: trig, eventKey: `${trig}-${leadId}`, source: "test" });
    }
    // No fax_request_enqueued audit, no current-event flag → must NOT reach
    // AWAITING_MED_RECS (we never claim we are awaiting records that were never
    // requested).
    await applyDocumentsSigned(leadId, { keySuffix: "final-sig", source: "test", hipaaFaxed: false });
    assert.equal(await statusOf(leadId), PipelineStatus.DOCS_SIGNED);
    const trail = await appliedTrail(leadId);
    assert.ok(!trail.includes(PipelineStatus.AWAITING_MED_RECS), "did not over-advance");
  });

  test("inbound med-recs attaches the received PDF to the document store (idempotently)", async () => {
    const leadId = await makeLead("Attach Claimant");
    leadIds.push(leadId);
    const { transitionLead } = await import("../pipeline/state-machine.js");
    const chain: Array<[string, string]> = [
      [PipelineStatus.NEW, "t_new"],
      [PipelineStatus.BG_CHECK_PENDING, "t_bgp"],
      [PipelineStatus.BG_CHECK_CLEAR, "t_bgc"],
      [PipelineStatus.INTAKE_SENT, "t_is"],
      [PipelineStatus.INTAKE_COMPLETED, "t_ic"],
      [PipelineStatus.NPI_PENDING, "t_np"],
      [PipelineStatus.NPI_VERIFIED, "t_nv"],
      [PipelineStatus.DOCS_SENT, "t_ds"],
      [PipelineStatus.DOCS_SIGNED, "t_dsi"],
      [PipelineStatus.HIPAA_FAXED, "t_hf"],
      [PipelineStatus.AWAITING_MED_RECS, "t_amr"],
    ];
    for (const [to, trig] of chain) {
      await transitionLead({ leadId, to: to as never, trigger: trig, eventKey: `${trig}-${leadId}`, source: "test" });
    }

    const out = await applyMedRecordsReceived(leadId, {
      keySuffix: "fax-attach-1",
      source: "test",
      attachment: { fileUrl: "https://fax.example/med-recs/abc.pdf", externalFaxId: "abc" },
    });
    assert.equal(out.attached, true, "reports the PDF was attached");
    assert.equal(await statusOf(leadId), PipelineStatus.COMPLETE);

    const docs = await db
      .select()
      .from(documentsTable)
      .where(and(eq(documentsTable.lead_id, leadId), eq(documentsTable.document_type, "medical_records")));
    assert.equal(docs.length, 1, "exactly one medical_records document attached");
    assert.equal(docs[0]!.file_url, "https://fax.example/med-recs/abc.pdf");

    // Replaying the same inbound fax must not duplicate the attachment.
    await applyMedRecordsReceived(leadId, {
      keySuffix: "fax-attach-1",
      source: "test",
      attachment: { fileUrl: "https://fax.example/med-recs/abc.pdf", externalFaxId: "abc" },
    });
    const docsAfter = await db
      .select()
      .from(documentsTable)
      .where(and(eq(documentsTable.lead_id, leadId), eq(documentsTable.document_type, "medical_records")));
    assert.equal(docsAfter.length, 1, "replay did not duplicate the attachment");
  });

  test("inbound med-recs with no media URL records receipt as an honest gap (no fabricated file)", async () => {
    const leadId = await makeLead("No Media Claimant");
    leadIds.push(leadId);
    const { transitionLead } = await import("../pipeline/state-machine.js");
    const chain: Array<[string, string]> = [
      [PipelineStatus.NEW, "t_new"],
      [PipelineStatus.BG_CHECK_PENDING, "t_bgp"],
      [PipelineStatus.BG_CHECK_CLEAR, "t_bgc"],
      [PipelineStatus.INTAKE_SENT, "t_is"],
      [PipelineStatus.INTAKE_COMPLETED, "t_ic"],
      [PipelineStatus.NPI_PENDING, "t_np"],
      [PipelineStatus.NPI_VERIFIED, "t_nv"],
      [PipelineStatus.DOCS_SENT, "t_ds"],
      [PipelineStatus.DOCS_SIGNED, "t_dsi"],
      [PipelineStatus.HIPAA_FAXED, "t_hf"],
      [PipelineStatus.AWAITING_MED_RECS, "t_amr"],
    ];
    for (const [to, trig] of chain) {
      await transitionLead({ leadId, to: to as never, trigger: trig, eventKey: `${trig}-${leadId}`, source: "test" });
    }

    const out = await applyMedRecordsReceived(leadId, {
      keySuffix: "fax-nomedia-1",
      source: "test",
      attachment: { fileUrl: null, externalFaxId: "nomedia" },
    });
    assert.equal(out.attached, false, "reports no media was attached (honest)");
    assert.equal(await statusOf(leadId), PipelineStatus.COMPLETE);

    const docs = await db
      .select()
      .from(documentsTable)
      .where(and(eq(documentsTable.lead_id, leadId), eq(documentsTable.document_type, "medical_records")));
    assert.equal(docs.length, 1, "receipt row created");
    assert.equal(docs[0]!.file_url, null, "no fabricated file URL");
  });
});

describe("DOCS_SIGNED all-documents-signed gate", () => {
  test("does not advance until EVERY envelope for the lead is signed", () => {
    // No envelopes at all → not signed (nothing to execute).
    assert.equal(allDocumentsSigned([]), false);
    // A single signed envelope → fully signed.
    assert.equal(allDocumentsSigned(["signed"]), true);
    // Three required documents, only two signed → still gated.
    assert.equal(allDocumentsSigned(["signed", "signed", "delivered"]), false);
    // The last of the three signs → advance.
    assert.equal(allDocumentsSigned(["signed", "signed", "signed"]), true);
  });

  test("a still-in-flight envelope blocks the advance", () => {
    assert.equal(allDocumentsSigned(["created"]), false);
    assert.equal(allDocumentsSigned(["viewed", "signed"]), false);
    assert.equal(allDocumentsSigned(["signed", "sent"]), false);
    assert.equal(allDocumentsSigned(["signed", "delivered"]), false);
  });

  test("dead/replaced envelopes are ignored, not deadlocking the lead", () => {
    // A voided draft followed by a signed replacement should advance.
    assert.equal(allDocumentsSigned(["voided", "signed"]), true);
    assert.equal(allDocumentsSigned(["signed", "declined"]), true);
    assert.equal(allDocumentsSigned(["signed", "expired"]), true);
    assert.equal(allDocumentsSigned(["voided", "expired", "signed"]), true);
    // But a dead envelope with nothing actually signed must NOT advance.
    assert.equal(allDocumentsSigned(["voided"]), false);
    assert.equal(allDocumentsSigned(["declined", "expired"]), false);
    // A live in-flight envelope still blocks even alongside a signed one.
    assert.equal(allDocumentsSigned(["voided", "signed", "sent"]), false);
  });
});

describe("DOCS_SIGNED per-required-type gate (allRequiredDocumentsSigned)", () => {
  const env = (doc_type: string | null, status: string) => ({ doc_type, status });

  test("requires ALL THREE required doc types to each be live-and-signed", () => {
    // Only HIPAA signed → still gated (retainer + affidavit missing).
    assert.equal(allRequiredDocumentsSigned([env("hipaa", "signed")]), false);
    // HIPAA + retainer signed, affidavit missing → gated.
    assert.equal(
      allRequiredDocumentsSigned([env("hipaa", "signed"), env("retainer", "signed")]),
      false,
    );
    // All three signed → advance.
    assert.equal(
      allRequiredDocumentsSigned([
        env("hipaa", "signed"),
        env("retainer", "signed"),
        env("affidavit", "signed"),
      ]),
      true,
    );
  });

  test("a required type present but still in-flight blocks the advance", () => {
    assert.equal(
      allRequiredDocumentsSigned([
        env("hipaa", "signed"),
        env("retainer", "signed"),
        env("affidavit", "sent"),
      ]),
      false,
    );
  });

  test("a dead envelope replaced by a signed one of the same type still advances", () => {
    assert.equal(
      allRequiredDocumentsSigned([
        env("hipaa", "voided"),
        env("hipaa", "signed"),
        env("retainer", "signed"),
        env("affidavit", "signed"),
      ]),
      true,
    );
  });

  test("a required type with only dead envelopes (none signed) blocks", () => {
    assert.equal(
      allRequiredDocumentsSigned([
        env("hipaa", "voided"),
        env("retainer", "signed"),
        env("affidavit", "signed"),
      ]),
      false,
    );
  });

  test("untagged (null doc_type) envelopes do not satisfy any required type", () => {
    assert.equal(
      allRequiredDocumentsSigned([
        env(null, "signed"),
        env(null, "signed"),
        env(null, "signed"),
      ]),
      false,
    );
  });
});

describe("classifyEnvelopeDocType", () => {
  const tpl = (over: Record<string, unknown>) => ({
    name: "",
    document_type: null,
    ...over,
  });

  test("classifies HIPAA / retainer / affidavit from template signal", () => {
    assert.equal(classifyEnvelopeDocType(tpl({ name: "HIPAA Authorization" })), "hipaa");
    assert.equal(classifyEnvelopeDocType(tpl({ name: "Retainer Agreement" })), "retainer");
    assert.equal(classifyEnvelopeDocType(tpl({ name: "Affidavit of Claimant" })), "affidavit");
  });

  test("returns null for a template that is none of the three required docs", () => {
    assert.equal(classifyEnvelopeDocType(tpl({ name: "Welcome Letter" })), null);
  });
});
