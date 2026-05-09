import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { adaptPacer } from "../bg-hub/adapters.js";
import { statusFromFlags, BACKGROUND_ESCALATION_RULES } from "../bg-hub/escalation.js";
import { runBackgroundCheckHub } from "../bg-hub/hub.js";
import { BACKGROUND_SOURCES } from "../bg-hub/sources.js";
import { BG_HUB_VERSION, type LeadLike } from "../bg-hub/types.js";

describe("bg-hub: escalation arbiter", () => {
  test("FAIL takes precedence over REVIEW", () => {
    const r = statusFromFlags("email", ["no_mx_records", "role_based_email"]);
    assert.equal(r.status, "FAIL");
    assert.equal(r.score, 0);
  });

  test("REVIEW takes precedence over PASS", () => {
    const r = statusFromFlags("email", ["role_based_email"]);
    assert.equal(r.status, "REVIEW_REQUIRED");
    assert.equal(r.score, 50);
  });

  test("Unknown flags route to REVIEW (never silent PASS)", () => {
    const r = statusFromFlags("email", ["something_we_didnt_define"]);
    assert.equal(r.status, "REVIEW_REQUIRED");
    assert.equal(r.score, 60);
  });

  test("Empty flags → PASS at 100", () => {
    const r = statusFromFlags("email", []);
    assert.equal(r.status, "PASS");
    assert.equal(r.score, 100);
  });

  test("NSOPW manual-check flag is REVIEW, not FAIL", () => {
    const r = statusFromFlags("sex_offender_nsopw", ["nsopw_manual_check_required"]);
    assert.equal(r.status, "REVIEW_REQUIRED");
  });

  test("NSOPW confirmed registry match is FAIL", () => {
    const r = statusFromFlags("sex_offender_nsopw", ["confirmed_registry_match"]);
    assert.equal(r.status, "FAIL");
  });

  test("criminal_court: OFAC unavailable flag escalates to REVIEW (no silent PASS)", () => {
    // Regression guard: a "clean" CourtListener result + OFAC-skipped MUST
    // NOT yield PASS. This is the silent-pass vector flagged in the
    // 2026-04-29 architect review of the Background Check Hub.
    const r = statusFromFlags("criminal_court", ["ofac_unavailable"]);
    assert.equal(r.status, "REVIEW_REQUIRED");
    assert.notEqual(r.status, "PASS");
  });

  test("criminal_court: court_source_unreachable also REVIEW (defense-in-depth)", () => {
    const r = statusFromFlags("criminal_court", ["court_source_unreachable"]);
    assert.equal(r.status, "REVIEW_REQUIRED");
  });

  test("criminal_court: confirmed_criminal_match still FAILs even alongside ofac_unavailable", () => {
    // Precedence sanity: REVIEW flags must not downgrade a FAIL.
    const r = statusFromFlags("criminal_court", [
      "ofac_unavailable",
      "confirmed_criminal_match",
    ]);
    assert.equal(r.status, "FAIL");
  });
});

describe("bg-hub: source registry", () => {
  test("every lane has at least one source", () => {
    for (const lane of Object.keys(BACKGROUND_ESCALATION_RULES)) {
      const sources = BACKGROUND_SOURCES[lane as keyof typeof BACKGROUND_SOURCES];
      assert.ok(sources.length > 0, `lane ${lane} has no sources`);
    }
  });

  test("lanes with live adapters declare live_adapter_available=true on at least one source", () => {
    // address, email, phone, criminal_court, pacer_federal are the live lanes.
    for (const lane of ["address", "email", "phone", "criminal_court", "pacer_federal"] as const) {
      const sources = BACKGROUND_SOURCES[lane];
      const hasLive = sources.some((s) => s.live_adapter_available);
      assert.ok(hasLive, `lane ${lane} should have at least one live source`);
    }
  });

  test("honest-stub lanes do NOT claim live_adapter_available", () => {
    for (const lane of [
      "residency",
      "incarceration",
      "sex_offender_nsopw",
      "attorney",
      "business_entity",
    ] as const) {
      const sources = BACKGROUND_SOURCES[lane];
      const hasLive = sources.some((s) => s.live_adapter_available);
      assert.equal(
        hasLive,
        false,
        `lane ${lane} should NOT claim a live adapter — these are honest stubs`,
      );
    }
  });
});

describe("bg-hub: full pipeline", () => {
  const baseLead: LeadLike = {
    id: 12345,
    first_name: "Aaaaaa",
    last_name: "Zzzzzz",
    email: "Aaaaaa.zzzzzz+test@example.com",
    phone: "5555555555",
    address: "123 Main St",
    city: "Phoenix",
    state: "AZ",
    zip: "85001",
  };

  test("returns one result per lane in stable order", async () => {
    const result = await runBackgroundCheckHub(baseLead);
    assert.equal(result.results.length, 10);
    assert.deepEqual(
      result.results.map((r) => r.lane),
      [
        "address",
        "email",
        "phone",
        "residency",
        "criminal_court",
        "incarceration",
        "sex_offender_nsopw",
        "attorney",
        "business_entity",
        "pacer_federal",
      ],
    );
  });

  test("version stamp matches constant", async () => {
    const result = await runBackgroundCheckHub(baseLead);
    assert.equal(result.version, BG_HUB_VERSION);
  });

  test("does NOT include any provider/NPI lane (correctly excluded per architecture)", async () => {
    const result = await runBackgroundCheckHub(baseLead);
    assert.equal(
      result.results.find((r) => (r.lane as string) === "provider_npi"),
      undefined,
    );
  });

  test("never fake-passes NSOPW", async () => {
    const result = await runBackgroundCheckHub(baseLead);
    const nsopw = result.results.find((r) => r.lane === "sex_offender_nsopw");
    assert.ok(nsopw, "NSOPW lane should be present");
    assert.equal(nsopw.status, "REVIEW_REQUIRED");
    assert.ok(nsopw.flags.includes("nsopw_manual_check_required"));
  });

  test("business_entity is NOT_RUN when no business_name", async () => {
    const result = await runBackgroundCheckHub(baseLead);
    const biz = result.results.find((r) => r.lane === "business_entity");
    assert.ok(biz);
    assert.equal(biz.status, "NOT_RUN");
    assert.equal(biz.flags.length, 0);
  });

  test("business_entity is REVIEW when business_name present", async () => {
    const result = await runBackgroundCheckHub({ ...baseLead, business_name: "Acme Corp" });
    const biz = result.results.find((r) => r.lane === "business_entity");
    assert.ok(biz);
    assert.equal(biz.status, "REVIEW_REQUIRED");
    assert.ok(biz.flags.includes("manual_entity_check_required"));
  });

  test("missing email surfaces as missing_email and contributes to REVIEW final", async () => {
    const result = await runBackgroundCheckHub({ ...baseLead, email: null });
    const email = result.results.find((r) => r.lane === "email");
    assert.ok(email);
    assert.equal(email.status, "FAIL");
    assert.ok(email.flags.includes("missing_email"));
    // FAIL on any lane → final FAIL
    assert.equal(result.final_status, "FAIL");
  });

  test("final status is REVIEW_REQUIRED for a clean-input lead (because honest stubs)", async () => {
    const result = await runBackgroundCheckHub(baseLead);
    // Even with valid inputs, residency/incarceration/nsopw/attorney lanes
    // are honest stubs that emit *_not_checked → REVIEW_REQUIRED. So a
    // clean lead never auto-PASSes the hub. This is intentional.
    assert.equal(result.final_status, "REVIEW_REQUIRED");
  });

  test("summary counts are consistent with results array", async () => {
    const result = await runBackgroundCheckHub(baseLead);
    const tally = {
      pass: result.results.filter((r) => r.status === "PASS").length,
      review_required: result.results.filter((r) => r.status === "REVIEW_REQUIRED").length,
      fail: result.results.filter((r) => r.status === "FAIL").length,
      not_run: result.results.filter((r) => r.status === "NOT_RUN").length,
    };
    assert.deepEqual(result.summary, tally);
    assert.equal(
      tally.pass + tally.review_required + tally.fail + tally.not_run,
      result.results.length,
    );
  });

  test("every result carries a non-empty sources array", async () => {
    const result = await runBackgroundCheckHub(baseLead);
    for (const r of result.results) {
      assert.ok(r.sources.length > 0, `lane ${r.lane} has empty sources`);
    }
  });
});

describe("bg-hub: pacer_federal lane", () => {
  const baseLead: LeadLike = {
    id: 9001,
    first_name: "Test",
    last_name: "Pacer",
    email: "x@x.com",
    phone: "+15555550100",
    address_line1: "1 Main St",
    city: "Austin",
    state: "TX",
    zip: "78701",
    dob: "1980-01-01",
  };

  test("missing first/last name → NOT_RUN (no flags, never PASS)", async () => {
    const r = await adaptPacer({ ...baseLead, first_name: "", last_name: "" });
    assert.equal(r.lane, "pacer_federal");
    assert.equal(r.status, "NOT_RUN");
    assert.equal(r.score, 0);
    assert.deepEqual(r.flags, []);
  });

  test("no PACER integration in vault → NOT_RUN with pacer_not_configured (honest, never silent PASS)", async () => {
    // Test environment has no `pacer` integration row, so loadPacerCredentials
    // returns null and searchPcl returns NOT_CONFIGURED — this is the
    // production path operators will see until they wire credentials.
    const r = await adaptPacer(baseLead);
    assert.equal(r.lane, "pacer_federal");
    assert.equal(r.status, "NOT_RUN");
    assert.deepEqual(r.flags, ["pacer_not_configured"]);
    assert.ok(r.sources.length > 0);
    assert.ok(r.sources.some((s) => s.live_adapter_available));
  });

  test("escalation: pacer_records_found_review → REVIEW_REQUIRED (never auto-FAIL on a name hit)", () => {
    const r = statusFromFlags("pacer_federal", ["pacer_records_found_review"]);
    assert.equal(r.status, "REVIEW_REQUIRED");
  });

  test("escalation: pacer_active_criminal_docket → REVIEW_REQUIRED (operator confirms identity)", () => {
    const r = statusFromFlags("pacer_federal", ["pacer_active_criminal_docket"]);
    assert.equal(r.status, "REVIEW_REQUIRED");
  });

  test("escalation: pacer_auth_failed → REVIEW_REQUIRED (configured source must not silently PASS)", () => {
    const r = statusFromFlags("pacer_federal", ["pacer_auth_failed"]);
    assert.equal(r.status, "REVIEW_REQUIRED");
  });

  test("escalation: pacer_source_unreachable → REVIEW_REQUIRED (network failure ≠ clean record)", () => {
    const r = statusFromFlags("pacer_federal", ["pacer_source_unreachable"]);
    assert.equal(r.status, "REVIEW_REQUIRED");
  });

  test("escalation: pacer_confirmed_criminal_match → FAIL (only after operator-confirmed match)", () => {
    const r = statusFromFlags("pacer_federal", ["pacer_confirmed_criminal_match"]);
    assert.equal(r.status, "FAIL");
  });
});
