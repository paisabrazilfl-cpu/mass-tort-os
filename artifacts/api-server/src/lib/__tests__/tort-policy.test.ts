// Tests pin the tort → lane policy contract. Important behaviors:
//
//  - Roblox / Discord / Snap (child-safety) skip business_entity and
//    attorney; mark incarceration/pacer/residency as advisory.
//  - Camp Lejeune / Roundup / talc (medical_injury) run every lane.
//  - Securities / data_breach skip the medical-style lanes entirely.
//  - Unknown tort slugs default to "run everything" (safer than
//    skipping when we don't know what the tort is).
//
// Adding a new tort to TORT_CATEGORY_BY_SLUG is a one-line change in
// tort-policy.ts; if the addition silently misclassifies the tort,
// these tests catch it.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { applicableLanesFor, categorizeTort, lanePolicyFor } from "../bg-hub/tort-policy";
import type { BackgroundLane } from "../bg-hub/types";

const ALL_LANES: BackgroundLane[] = [
  "address",
  "email",
  "phone",
  "phone_provenance",
  "residency",
  "criminal_court",
  "incarceration",
  "sex_offender_nsopw",
  "attorney",
  "business_entity",
  "pacer_federal",
];

describe("tort categorization", () => {
  test("roblox → child_safety", () => {
    assert.equal(categorizeTort("roblox"), "child_safety");
  });
  test("ROBLOX uppercased → child_safety", () => {
    assert.equal(categorizeTort("ROBLOX"), "child_safety");
  });
  test("camp_lejeune (underscore) → medical_injury", () => {
    assert.equal(categorizeTort("camp_lejeune"), "medical_injury");
  });
  test("camp-lejeune (dash) → medical_injury", () => {
    assert.equal(categorizeTort("camp-lejeune"), "medical_injury");
  });
  test("zantac → pharmaceutical_injury", () => {
    assert.equal(categorizeTort("zantac"), "pharmaceutical_injury");
  });
  test("unknown slug → unknown (run everything)", () => {
    assert.equal(categorizeTort("space-elevator-collapse"), "unknown");
    assert.equal(categorizeTort(""), "unknown");
    assert.equal(categorizeTort(null), "unknown");
  });
});

describe("lane policy: child_safety (Roblox-style)", () => {
  test("attorney + business_entity lanes are SKIPPED", () => {
    assert.equal(lanePolicyFor("child_safety", "attorney"), "skip");
    assert.equal(lanePolicyFor("child_safety", "business_entity"), "skip");
  });
  test("incarceration + pacer + residency are ADVISORY (run, but don't gate)", () => {
    assert.equal(lanePolicyFor("child_safety", "incarceration"), "advisory");
    assert.equal(lanePolicyFor("child_safety", "pacer_federal"), "advisory");
    assert.equal(lanePolicyFor("child_safety", "residency"), "advisory");
  });
  test("identity-style lanes still RUN", () => {
    assert.equal(lanePolicyFor("child_safety", "address"), "run");
    assert.equal(lanePolicyFor("child_safety", "email"), "run");
    assert.equal(lanePolicyFor("child_safety", "phone"), "run");
    assert.equal(lanePolicyFor("child_safety", "phone_provenance"), "run");
    assert.equal(lanePolicyFor("child_safety", "criminal_court"), "run");
    assert.equal(lanePolicyFor("child_safety", "sex_offender_nsopw"), "run");
  });
});

describe("lane policy: medical_injury (Camp Lejeune-style)", () => {
  test("every lane runs", () => {
    for (const lane of ALL_LANES) {
      const p = lanePolicyFor("medical_injury", lane);
      assert.equal(p, "run", `lane ${lane} should run for medical_injury, got ${p}`);
    }
  });
});

describe("lane policy: data_breach", () => {
  test("medical-style lanes are skipped", () => {
    assert.equal(lanePolicyFor("data_breach", "incarceration"), "skip");
    assert.equal(lanePolicyFor("data_breach", "sex_offender_nsopw"), "skip");
    assert.equal(lanePolicyFor("data_breach", "attorney"), "skip");
    assert.equal(lanePolicyFor("data_breach", "business_entity"), "skip");
    assert.equal(lanePolicyFor("data_breach", "pacer_federal"), "skip");
  });
  test("address + email + phone still run", () => {
    assert.equal(lanePolicyFor("data_breach", "address"), "run");
    assert.equal(lanePolicyFor("data_breach", "email"), "run");
    assert.equal(lanePolicyFor("data_breach", "phone"), "run");
    assert.equal(lanePolicyFor("data_breach", "residency"), "run");
  });
});

describe("lane policy: securities", () => {
  test("identity-style lanes are skipped (business + attorney are the point)", () => {
    assert.equal(lanePolicyFor("securities", "incarceration"), "skip");
    assert.equal(lanePolicyFor("securities", "sex_offender_nsopw"), "skip");
    assert.equal(lanePolicyFor("securities", "residency"), "skip");
  });
  test("attorney + business_entity run (default)", () => {
    assert.equal(lanePolicyFor("securities", "attorney"), "run");
    assert.equal(lanePolicyFor("securities", "business_entity"), "run");
  });
});

describe("applicableLanesFor", () => {
  test("child_safety drops attorney + business_entity from the lane list", () => {
    const lanes = applicableLanesFor("child_safety", ALL_LANES);
    assert.ok(!lanes.includes("attorney"));
    assert.ok(!lanes.includes("business_entity"));
    assert.ok(lanes.includes("sex_offender_nsopw"));
  });
  test("medical_injury keeps every lane", () => {
    const lanes = applicableLanesFor("medical_injury", ALL_LANES);
    assert.equal(lanes.length, ALL_LANES.length);
  });
  test("unknown keeps every lane (safe default)", () => {
    const lanes = applicableLanesFor("unknown", ALL_LANES);
    assert.equal(lanes.length, ALL_LANES.length);
  });
});
