import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { validateTortClaim, getTortCategories, TORT_REGISTRY } from "../tort-engine";

describe("tort-engine", () => {
  it("validates a matching claim by label", () => {
    const res = validateTortClaim({
      tort_type: "Roundup",
      diagnosis: "Non-Hodgkin Lymphoma",
      exposure_start: "2010-01-01",
    });
    assert.equal(res.valid, true);
    assert.equal(res.tort_id, "roundup");
    assert.equal(res.diagnosis_match, true);
    assert.equal(res.category, "pharmaceutical");
    assert.deepEqual(res.errors, []);
  });

  it("validates a matching claim by id", () => {
    const res = validateTortClaim({
      tort_type: "paraquat",
      diagnosis: "Parkinson's disease",
      exposure_start: "2015-01-01",
    });
    assert.equal(res.valid, true);
    assert.equal(res.tort_id, "paraquat");
    assert.equal(res.diagnosis_match, true);
    assert.equal(res.category, "pharmaceutical");
  });

  it("handles mixed-case tort inputs", () => {
    const res = validateTortClaim({
      tort_type: "CAMP LEJEUNE",
      diagnosis: "Kidney Cancer",
      exposure_start: "1965-01-01",
      exposure_end: "1970-01-01",
      location_name: "Base Camp",
    });
    assert.equal(res.valid, true);
    assert.equal(res.tort_id, "camp-lejeune");
  });

  it("flags unknown tort types", () => {
    const res = validateTortClaim({
      tort_type: "unknown_tort_xyz",
      diagnosis: "Some Condition",
    });
    assert.equal(res.valid, false);
    assert.equal(res.tort_id, null);
    assert.deepEqual(res.errors, ["UNKNOWN_TORT_TYPE"]);
  });

  it("flags diagnosis mismatches", () => {
    const res = validateTortClaim({
      tort_type: "roundup",
      diagnosis: "broken leg",
      exposure_start: "2010-01-01",
    });
    assert.equal(res.valid, false);
    assert.equal(res.diagnosis_match, false);
    assert.ok(res.errors.includes("DIAGNOSIS_MISMATCH"));
  });

  it("flags missing exposure when required", () => {
    const res = validateTortClaim({
      tort_type: "roundup",
      diagnosis: "Non-Hodgkin Lymphoma",
    });
    assert.equal(res.valid, false);
    assert.ok(res.errors.includes("NO_EXPOSURE"));
  });

  it("enforces location and date rules for asbestos and camp lejeune", () => {
    const res = validateTortClaim({
      tort_type: "camp-lejeune",
      diagnosis: "Kidney Cancer",
      exposure_start: "1950-01-01", // outside 1953-1987
    });
    assert.equal(res.valid, false);
    assert.ok(res.errors.includes("TORT_RULE:LOCATION_REQUIRED"));
    assert.ok(res.errors.includes("EXPOSURE_OUTSIDE_1953_1987"));
  });

  it("returns structured categories from getTortCategories", () => {
    const categories = getTortCategories();
    assert.ok(Array.isArray(categories));
    assert.ok(categories.length > 0);

    const pharmaCat = categories.find((c) => c.category === "pharmaceutical");
    assert.ok(pharmaCat);
    assert.ok(pharmaCat.torts.some((t) => t.id === "roundup" && t.label === "Roundup"));

    // Verify all registered torts are represented in categories
    const totalTortsInCategories = categories.reduce((sum, c) => sum + c.torts.length, 0);
    assert.equal(totalTortsInCategories, Object.keys(TORT_REGISTRY).length);
  });
});
