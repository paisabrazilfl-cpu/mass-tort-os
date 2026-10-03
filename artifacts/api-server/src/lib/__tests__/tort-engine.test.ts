import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { validateTortClaim, getTortCategories } from "../tort-engine";

describe("tort-engine", () => {
  describe("validateTortClaim", () => {
    test("validates known tort claim with exact diagnosis", () => {
      const res = validateTortClaim({
        tort_type: "Roundup",
        diagnosis: "non-hodgkin lymphoma",
        exposure_start: "2015-01-01",
      });
      assert.strictEqual(res.valid, true);
      assert.strictEqual(res.tort_id, "roundup");
      assert.strictEqual(res.diagnosis_match, true);
      assert.strictEqual(res.category, "pharmaceutical");
      assert.deepStrictEqual(res.errors, []);
    });

    test("validates known tort by ID (lowercase key)", () => {
      const res = validateTortClaim({
        tort_type: "roundup",
        diagnosis: "dlbcl",
        exposure_start: "2018-01-01",
      });
      assert.strictEqual(res.valid, true);
      assert.strictEqual(res.tort_id, "roundup");
      assert.strictEqual(res.diagnosis_match, true);
    });

    test("returns UNKNOWN_TORT_TYPE for invalid tort name", () => {
      const res = validateTortClaim({
        tort_type: "NonExistentTort123",
        diagnosis: "cancer",
      });
      assert.strictEqual(res.valid, false);
      assert.strictEqual(res.tort_id, null);
      assert.deepStrictEqual(res.errors, ["UNKNOWN_TORT_TYPE"]);
    });

    test("handles DIAGNOSIS_MISMATCH for invalid diagnosis", () => {
      const res = validateTortClaim({
        tort_type: "Roundup",
        diagnosis: "headache",
        exposure_start: "2015-01-01",
      });
      assert.strictEqual(res.valid, false);
      assert.strictEqual(res.diagnosis_match, false);
      assert.ok(res.errors.includes("DIAGNOSIS_MISMATCH"));
    });

    test("validates Camp Lejeune date window rules with ISO and US date formats", () => {
      const validIso = validateTortClaim({
        tort_type: "Camp Lejeune",
        diagnosis: "Kidney Cancer",
        exposure_start: "1975-06-01",
        exposure_end: "1980-06-01",
        location_name: "Camp Lejeune Base",
      });
      assert.strictEqual(validIso.valid, true);

      const validUsFormat = validateTortClaim({
        tort_type: "Camp Lejeune",
        diagnosis: "Kidney Cancer",
        exposure_start: "06/15/1975",
        exposure_end: "06/15/1980",
        location_name: "Camp Lejeune Base",
      });
      assert.strictEqual(validUsFormat.valid, true);

      const invalidIso = validateTortClaim({
        tort_type: "Camp Lejeune",
        diagnosis: "Kidney Cancer",
        exposure_start: "1995-06-01",
        exposure_end: "1998-06-01",
        location_name: "Camp Lejeune Base",
      });
      assert.strictEqual(invalidIso.valid, false);
      assert.ok(invalidIso.errors.includes("EXPOSURE_OUTSIDE_1953_1987"));
    });
  });

  describe("getTortCategories", () => {
    test("returns grouped categories matching TORT_REGISTRY", () => {
      const categories = getTortCategories();
      assert.ok(Array.isArray(categories));
      assert.ok(categories.length > 0);

      const pharmaCategory = categories.find((c) => c.category === "pharmaceutical");
      assert.ok(pharmaCategory);
      assert.ok(pharmaCategory.torts.some((t) => t.id === "roundup"));
    });
  });
});
