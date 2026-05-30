// Firm-tenancy regression coverage for the voice intake feature.
//
// Two security invariants are pinned here because both were live cross-tenant
// leak paths before being fixed:
//
//   (1) INBOUND firm scoping — the dialed (destination) number is the
//       authoritative tenancy signal. Even when the TORT is resolved from a
//       stronger signal (call metadata or the Vapi assistant id), the owning
//       firm must still be sourced from the dedicated-number mapping. If it
//       weren't, an inbound call would carry firmId=null into find-or-create
//       and fall through to GLOBAL dedup, attaching the caller to another
//       firm's lead.
//
//   (2) OUTBOUND enrichment — buildLeadCallContext decrypts a full lead into
//       live call variables/prompt, so a firm-scoped operator must only ever
//       enrich a lead in its OWN firm. It must fail closed for both cross-firm
//       rows AND unscoped (firm_id IS NULL) rows; only the dev/unscoped caller
//       (firmId=null) is allowed through.
//
// Follows the repo integration-test pattern: seed real rows in unique
// namespaces, assert behavior, and clean up exactly what we created.

import { describe, test, before, after } from "node:test";
import assert from "node:assert/strict";
import {
  db,
  leadsTable,
  tortPhoneNumbersTable,
  tortVoiceAgentsTable,
} from "@workspace/db";
import { eq, inArray } from "drizzle-orm";
import { TORT_REGISTRY } from "../tort-engine.js";
import { resolveInboundTort } from "../voice/inbound-routing.js";
import { buildLeadCallContext } from "../voice/lead-call-context.js";

const NS = `voice-tenancy-${Date.now()}`;
const FIRM_A = 880001;
const FIRM_B = 880002;
const REAL_TORT = Object.keys(TORT_REGISTRY)[0]!;

// A unique dialed number so phone10() matching never collides with real data.
const DIALED = `+1555${String(Date.now() % 10_000_000).padStart(7, "0")}`;
const UNMAPPED = "+19998887766";
const VAPI_NUMBER_ID = `vphone_${NS}`;

// Fake tort id for the assistant-lane row — tort_id is UNIQUE, so a namespaced
// value avoids clobbering any real provisioned agent.
const AGENT_TORT = `${NS}-agent-tort`;
const ASSISTANT_ID = `asst_${NS}`;

const leadIds: number[] = [];
let leadAId = 0;
let leadNullId = 0;

describe("voice intake firm tenancy", () => {
  before(async () => {
    const [num] = await db
      .insert(tortPhoneNumbersTable)
      .values({
        tort_id: REAL_TORT,
        phone_number: DIALED,
        vapi_phone_number_id: VAPI_NUMBER_ID,
        firm_id: FIRM_A,
        active: true,
      })
      .returning({ id: tortPhoneNumbersTable.id });
    assert.ok(num);

    await db
      .insert(tortVoiceAgentsTable)
      .values({
        tort_id: AGENT_TORT,
        tort_label: "Voice Tenancy Fixture",
        vapi_assistant_id: ASSISTANT_ID,
        status: "active",
      });

    const [leadA] = await db
      .insert(leadsTable)
      .values({ name: "Tenancy Fixture", tort_type: REAL_TORT, status: "web_form_intake", firm_id: FIRM_A })
      .returning({ id: leadsTable.id });
    leadAId = leadA!.id;
    leadIds.push(leadAId);

    const [leadNull] = await db
      .insert(leadsTable)
      .values({ name: "Unscoped Fixture", tort_type: REAL_TORT, status: "web_form_intake", firm_id: null })
      .returning({ id: leadsTable.id });
    leadNullId = leadNull!.id;
    leadIds.push(leadNullId);
  });

  after(async () => {
    if (leadIds.length > 0) await db.delete(leadsTable).where(inArray(leadsTable.id, leadIds));
    await db.delete(tortPhoneNumbersTable).where(eq(tortPhoneNumbersTable.phone_number, DIALED));
    await db.delete(tortVoiceAgentsTable).where(eq(tortVoiceAgentsTable.tort_id, AGENT_TORT));
  });

  // ── resolveInboundTort ────────────────────────────────────────────────────

  test("metadata-resolved tort still adopts the dialed number's firm", async () => {
    const r = await resolveInboundTort({ metadataTortId: REAL_TORT, dialedNumber: DIALED });
    assert.equal(r.tortId, REAL_TORT, "metadata wins the tort");
    assert.equal(r.firmId, FIRM_A, "firm must come from the dialed-number mapping");
  });

  test("assistant-resolved tort still adopts the dialed number's firm", async () => {
    const r = await resolveInboundTort({ assistantId: ASSISTANT_ID, dialedNumber: DIALED });
    assert.equal(r.tortId, AGENT_TORT, "assistant lane wins the tort");
    assert.equal(r.firmId, FIRM_A, "firm must come from the dialed-number mapping");
  });

  test("dialed-number-only lane yields both tort and firm", async () => {
    const r = await resolveInboundTort({ dialedNumber: DIALED });
    assert.equal(r.tortId, REAL_TORT);
    assert.equal(r.firmId, FIRM_A);
  });

  test("phoneNumberId-only event (no dialed E.164) still scopes the firm", async () => {
    const r = await resolveInboundTort({
      assistantId: ASSISTANT_ID,
      dialedNumber: null,
      dialedNumberId: VAPI_NUMBER_ID,
    });
    assert.equal(r.tortId, AGENT_TORT, "assistant lane wins the tort");
    assert.equal(r.firmId, FIRM_A, "firm must be recovered from the vapi number id");
  });

  test("unmapped dialed number carries no firm", async () => {
    const r = await resolveInboundTort({ metadataTortId: REAL_TORT, dialedNumber: UNMAPPED });
    assert.equal(r.tortId, REAL_TORT);
    assert.equal(r.firmId, null, "no mapping → no tenancy signal");
  });

  // ── buildLeadCallContext ──────────────────────────────────────────────────

  test("same-firm caller can enrich the lead", async () => {
    const ctx = await buildLeadCallContext(leadAId, FIRM_A);
    assert.ok(ctx, "same-firm enrichment must succeed");
    assert.match(ctx!.summary, /Tenancy Fixture/);
  });

  test("cross-firm caller is rejected", async () => {
    const ctx = await buildLeadCallContext(leadAId, FIRM_B);
    assert.equal(ctx, null, "must not enrich another firm's lead");
  });

  test("unscoped (null-firm) lead is rejected for a firm-scoped caller", async () => {
    const ctx = await buildLeadCallContext(leadNullId, FIRM_A);
    assert.equal(ctx, null, "a scoped caller must not enrich a firm_id IS NULL lead");
  });

  test("dev/unscoped caller (firmId null) may enrich any lead", async () => {
    const ctx = await buildLeadCallContext(leadAId, null);
    assert.ok(ctx, "unscoped caller is the dev bypass path");
  });
});
