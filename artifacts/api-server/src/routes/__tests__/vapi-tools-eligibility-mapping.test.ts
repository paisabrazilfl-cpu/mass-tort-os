/**
 * Regression test for the Vapi check-eligibility verdict mapping.
 *
 * Background: the assistant branches on `result: "go" | "hold" | "abort"`.
 * The decision-engine emits `Action = "execute" | "modify" | "reject" | "review"`.
 * A previous mapping used the wrong vocabulary (ACCEPT/DEFER/ABORT) and
 * silently aborted every non-review lead. This test pins the mapping
 * so that future drift between the two enums fails CI instead of going
 * out as a live customer-facing regression.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mapEligibilityResult } from "../vapi-tools";

describe("mapEligibilityResult — decision-engine action → assistant verdict", () => {
  it("execute → go", () => {
    const out = mapEligibilityResult({ action: "execute", rationale: "all checks passed" });
    assert.equal(out.result, "go");
    assert.equal(out.reason, "all checks passed");
    assert.deepEqual(out.disqualifiers, []);
  });

  it("modify → hold", () => {
    const out = mapEligibilityResult({
      action: "modify",
      missing_fields: ["dob"],
    });
    assert.equal(out.result, "hold");
    assert.deepEqual(out.disqualifiers, ["missing:dob"]);
    // No rationale → falls back to first disqualifier.
    assert.equal(out.reason, "missing:dob");
  });

  it("review → hold", () => {
    const out = mapEligibilityResult({
      action: "review",
      ruin_flags: ["statute_of_limitations_warning"],
    });
    assert.equal(out.result, "hold");
    assert.deepEqual(out.disqualifiers, ["statute_of_limitations_warning"]);
    assert.equal(out.reason, "statute_of_limitations_warning");
  });

  it("reject → abort", () => {
    const out = mapEligibilityResult({
      action: "reject",
      rationale: "outside campaign criteria",
      ruin_flags: ["ineligible_jurisdiction"],
      contradictions: ["dob_after_exposure"],
    });
    assert.equal(out.result, "abort");
    // disqualifiers preserve order: ruin_flags, missing(prefixed), contradictions.
    assert.deepEqual(out.disqualifiers, [
      "ineligible_jurisdiction",
      "dob_after_exposure",
    ]);
    assert.equal(out.reason, "outside campaign criteria");
  });

  it("unknown action → abort (fail closed)", () => {
    const out = mapEligibilityResult({ action: "halt" as any });
    assert.equal(out.result, "abort");
    assert.equal(out.reason, "decision:halt");
  });

  it("missing action → abort (fail closed)", () => {
    const out = mapEligibilityResult({});
    assert.equal(out.result, "abort");
    assert.equal(out.reason, "decision:unknown");
    assert.deepEqual(out.disqualifiers, []);
  });

  it("uppercase action is normalized (defensive — engine emits lowercase)", () => {
    const out = mapEligibilityResult({ action: "EXECUTE" });
    assert.equal(out.result, "go");
  });

  it("disqualifiers concatenate ruin_flags + missing(prefixed) + contradictions in order", () => {
    const out = mapEligibilityResult({
      action: "review",
      ruin_flags: ["a", "b"],
      missing_fields: ["c", "d"],
      contradictions: ["e"],
    });
    assert.deepEqual(out.disqualifiers, [
      "a",
      "b",
      "missing:c",
      "missing:d",
      "e",
    ]);
  });

  it("whitespace-only rationale falls through to disqualifier reason", () => {
    const out = mapEligibilityResult({
      action: "execute",
      rationale: "   ",
      ruin_flags: ["minor_warning"],
    });
    assert.equal(out.reason, "minor_warning");
  });
});
