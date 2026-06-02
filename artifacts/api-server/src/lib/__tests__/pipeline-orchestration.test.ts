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
import { db, leadsTable, pipelineEventsTable } from "@workspace/db";
import { eq, asc } from "drizzle-orm";
import { PipelineStatus } from "../pipeline/state-machine.js";
import {
  startLeadPipeline,
  applyBackgroundCheckVerdict,
  applyMedRecordsReceived,
  allDocumentsSigned,
} from "../pipeline/pipeline.js";

async function makeLead(name: string): Promise<number> {
  const [lead] = await db
    .insert(leadsTable)
    .values({ name, tort_type: "test_tort" })
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
      await db.delete(leadsTable).where(eq(leadsTable.id, id));
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
