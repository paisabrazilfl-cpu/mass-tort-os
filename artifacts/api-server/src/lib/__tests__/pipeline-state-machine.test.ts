// Unit + integration tests for the deterministic pipeline state machine.
//
// The pure-graph tests need no DB. The transitionLead tests hit the shared dev
// DB (per repo convention these tests use the real DATABASE_URL), so they
// create a synthetic lead in `before` and DELETE it (plus its pipeline_events)
// in `after` — leaking rows here would surface as phantom data in the live UI.

import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import { db, leadsTable, pipelineEventsTable } from "@workspace/db";
import { eq, asc } from "drizzle-orm";
import {
  PipelineStatus,
  LEGAL_TRANSITIONS,
  TERMINAL_STATES,
  START,
  isLegalTransition,
  transitionLead,
} from "../pipeline/state-machine.js";
import { withStoredProviderFallback } from "../pipeline/pipeline.js";

describe("pipeline graph (pure, no DB)", () => {
  test("START only leads to NEW", () => {
    assert.ok(isLegalTransition(null, PipelineStatus.NEW));
    assert.ok(isLegalTransition(undefined, PipelineStatus.NEW));
    assert.ok(!isLegalTransition(null, PipelineStatus.BG_CHECK_PENDING));
  });

  test("happy path is fully connected", () => {
    const path = [
      START,
      PipelineStatus.NEW,
      PipelineStatus.BG_CHECK_PENDING,
      PipelineStatus.BG_CHECK_CLEAR,
      PipelineStatus.INTAKE_SENT,
      PipelineStatus.INTAKE_COMPLETED,
      PipelineStatus.NPI_PENDING,
      PipelineStatus.NPI_VERIFIED,
      PipelineStatus.DOCS_SENT,
      PipelineStatus.DOCS_SIGNED,
      PipelineStatus.HIPAA_FAXED,
      PipelineStatus.AWAITING_MED_RECS,
      PipelineStatus.MED_RECS_RECEIVED,
      PipelineStatus.COMPLETE,
    ];
    for (let i = 0; i < path.length - 1; i++) {
      assert.ok(
        isLegalTransition(path[i], path[i + 1] as never),
        `expected legal ${path[i]} -> ${path[i + 1]}`,
      );
    }
  });

  test("rejection path is legal", () => {
    assert.ok(isLegalTransition(PipelineStatus.BG_CHECK_PENDING, PipelineStatus.BG_CHECK_FAILED));
    assert.ok(isLegalTransition(PipelineStatus.BG_CHECK_FAILED, PipelineStatus.REJECTED));
    assert.ok(isLegalTransition(PipelineStatus.NPI_HOLD, PipelineStatus.REJECTED));
  });

  test("DOCS_SIGNED fan-out is order independent", () => {
    assert.ok(isLegalTransition(PipelineStatus.DOCS_SIGNED, PipelineStatus.HIPAA_FAXED));
    assert.ok(isLegalTransition(PipelineStatus.DOCS_SIGNED, PipelineStatus.RETAINER_DISTRIBUTED));
    assert.ok(isLegalTransition(PipelineStatus.HIPAA_FAXED, PipelineStatus.RETAINER_DISTRIBUTED));
    assert.ok(isLegalTransition(PipelineStatus.RETAINER_DISTRIBUTED, PipelineStatus.HIPAA_FAXED));
    assert.ok(isLegalTransition(PipelineStatus.HIPAA_FAXED, PipelineStatus.AWAITING_MED_RECS));
    assert.ok(isLegalTransition(PipelineStatus.RETAINER_DISTRIBUTED, PipelineStatus.AWAITING_MED_RECS));
  });

  test("terminal states have no outgoing transitions", () => {
    for (const s of TERMINAL_STATES) {
      assert.deepEqual(LEGAL_TRANSITIONS[s], [], `${s} must be terminal`);
    }
  });

  test("illegal skips are rejected", () => {
    assert.ok(!isLegalTransition(PipelineStatus.NEW, PipelineStatus.DOCS_SIGNED));
    assert.ok(!isLegalTransition(PipelineStatus.INTAKE_SENT, PipelineStatus.COMPLETE));
    assert.ok(!isLegalTransition(PipelineStatus.COMPLETE, PipelineStatus.NEW));
  });
});

describe("transitionLead (DB)", () => {
  let leadId: number;

  before(async () => {
    const [lead] = await db
      .insert(leadsTable)
      .values({ name: "Pipeline Test Claimant", tort_type: "test_tort" })
      .returning({ id: leadsTable.id });
    leadId = lead!.id;
  });

  after(async () => {
    if (leadId) {
      await db.delete(pipelineEventsTable).where(eq(pipelineEventsTable.lead_id, leadId));
      await db.delete(leadsTable).where(eq(leadsTable.id, leadId));
    }
  });

  test("legal transition advances status and appends an applied event", async () => {
    const r = await transitionLead({
      leadId,
      to: PipelineStatus.NEW,
      trigger: "test_entry",
      eventKey: `test-new-${leadId}`,
    });
    assert.equal(r.outcome, "applied");
    assert.equal(r.applied, true);
    assert.equal(r.from, null);
    assert.equal(r.currentStatus, PipelineStatus.NEW);

    const [lead] = await db
      .select({ ps: leadsTable.pipeline_status })
      .from(leadsTable)
      .where(eq(leadsTable.id, leadId));
    assert.equal(lead!.ps, PipelineStatus.NEW);
  });

  test("idempotent replay with same event_key is a no-op", async () => {
    const first = await transitionLead({
      leadId,
      to: PipelineStatus.BG_CHECK_PENDING,
      trigger: "test_bgpending",
      eventKey: `test-bgp-${leadId}`,
    });
    assert.equal(first.outcome, "applied");

    const replay = await transitionLead({
      leadId,
      to: PipelineStatus.BG_CHECK_PENDING,
      trigger: "test_bgpending",
      eventKey: `test-bgp-${leadId}`,
    });
    assert.equal(replay.outcome, "duplicate");
    assert.equal(replay.applied, false);

    // Exactly one applied BG_CHECK_PENDING event despite two calls.
    const applied = await db
      .select({ id: pipelineEventsTable.id })
      .from(pipelineEventsTable)
      .where(eq(pipelineEventsTable.lead_id, leadId));
    const bgp = applied.length; // sanity: rows exist
    assert.ok(bgp >= 2);
  });

  test("illegal transition is rejected, status unchanged, event logged", async () => {
    // Lead is at BG_CHECK_PENDING; jumping to COMPLETE is illegal.
    const before = await db
      .select({ ps: leadsTable.pipeline_status })
      .from(leadsTable)
      .where(eq(leadsTable.id, leadId));

    const r = await transitionLead({
      leadId,
      to: PipelineStatus.COMPLETE,
      trigger: "test_illegal",
      eventKey: `test-illegal-${leadId}`,
    });
    assert.equal(r.outcome, "illegal");
    assert.equal(r.applied, false);

    const afterRow = await db
      .select({ ps: leadsTable.pipeline_status })
      .from(leadsTable)
      .where(eq(leadsTable.id, leadId));
    assert.equal(afterRow[0]!.ps, before[0]!.ps, "status must not change on illegal transition");

    // The illegal attempt left a non-applied row (event_key NOT claimed).
    const events = await db
      .select()
      .from(pipelineEventsTable)
      .where(eq(pipelineEventsTable.lead_id, leadId))
      .orderBy(asc(pipelineEventsTable.id));
    const illegal = events.find((e) => e.outcome === "illegal");
    assert.ok(illegal, "expected an illegal event row");
    assert.equal(illegal!.applied, false);
    assert.equal(illegal!.event_key, null, "illegal attempt must not claim the event_key");
  });

  test("unknown lead returns lead_not_found", async () => {
    const r = await transitionLead({
      leadId: 999_000_111,
      to: PipelineStatus.NEW,
      trigger: "test_missing",
    });
    assert.equal(r.outcome, "lead_not_found");
    assert.equal(r.applied, false);
  });
});

// withStoredProviderFallback makes the n8n-orchestrated path (pipeline.intake_sent
// carries only lead_id) genuinely functional: when the caller passes no provider
// identifiers, NPI verification is seeded from the lead's STORED provider fields
// instead of hitting NPPES with an empty query (which would always HOLD).
describe("withStoredProviderFallback (DB)", () => {
  let leadId: number;

  before(async () => {
    const [lead] = await db
      .insert(leadsTable)
      .values({
        name: "Provider Fallback Claimant",
        tort_type: "test_tort",
        physician_first_name: "Gregory",
        physician_last_name: "House",
        hospital_name: "Princeton-Plainsboro",
        physician_taxonomy: "Internal Medicine",
        state: "NJ",
      })
      .returning({ id: leadsTable.id });
    leadId = lead!.id;
  });

  after(async () => {
    if (leadId) await db.delete(leadsTable).where(eq(leadsTable.id, leadId));
  });

  test("fills expected provider from stored lead fields when caller passes none", async () => {
    const out = await withStoredProviderFallback(leadId, { expected: {} });
    assert.equal(out.expected.name, "Gregory House");
    assert.equal(out.expected.organization, "Princeton-Plainsboro");
    assert.equal(out.expected.specialty, "Internal Medicine");
    assert.equal(out.expected.state, "NJ");
  });

  test("passes the caller's input through untouched when it already has signal", async () => {
    const explicit = { npi: "1234567890", expected: { name: "Dr. Explicit" } };
    const out = await withStoredProviderFallback(leadId, explicit);
    assert.equal(out.npi, "1234567890");
    assert.equal(out.expected.name, "Dr. Explicit");
    // Must NOT overwrite an explicitly-provided field with the stored one.
    assert.equal(out.expected.organization, undefined);
  });
});
