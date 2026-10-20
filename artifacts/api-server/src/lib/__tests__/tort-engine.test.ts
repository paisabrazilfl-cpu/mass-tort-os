import { describe, it } from "node:test";
import assert from "node:assert";
import { validateTortClaim, getTortCategories, TORT_REGISTRY } from "../tort-engine.js";

describe("tort-engine", () => {
  it("validates valid tort claims correctly", () => {
    const res = validateTortClaim({
      tort_type: "Roundup",
      diagnosis: "Non-Hodgkin Lymphoma",
      exposure_start: "2015-01-01",
    });

    assert.strictEqual(res.valid, true);
    assert.strictEqual(res.tort_id, "roundup");
    assert.strictEqual(res.diagnosis_match, true);
    assert.strictEqual(res.category, "pharmaceutical");
    assert.deepStrictEqual(res.errors, []);
  });

  it("handles case-insensitive tort lookup by id or label", () => {
    const res1 = validateTortClaim({
      tort_type: "CAMP-LEJEUNE",
      diagnosis: "kidney cancer",
      exposure_start: "1960-05-01",
      exposure_end: "1970-01-01",
      location_name: "Camp Lejeune",
    });
    assert.strictEqual(res1.valid, true);
    assert.strictEqual(res1.tort_id, "camp-lejeune");

    const res2 = validateTortClaim({
      tort_type: "AFFF / PFAS",
      diagnosis: "breast cancer",
      exposure_start: "2010-01-01",
      location_name: "Fire Station",
    });
    assert.strictEqual(res2.valid, true);
    assert.strictEqual(res2.tort_id, "afff");
  });

  it("detects unknown tort types", () => {
    const res = validateTortClaim({
      tort_type: "invalid_tort_slug",
      diagnosis: "cancer",
    });
    assert.strictEqual(res.valid, false);
    assert.strictEqual(res.tort_id, null);
    assert.deepStrictEqual(res.errors, ["UNKNOWN_TORT_TYPE"]);
  });

  it("detects diagnosis mismatch", () => {
    const res = validateTortClaim({
      tort_type: "roundup",
      diagnosis: "broken arm",
      exposure_start: "2015-01-01",
    });
    assert.strictEqual(res.valid, false);
    assert.strictEqual(res.diagnosis_match, false);
    assert.ok(res.errors.includes("DIAGNOSIS_MISMATCH"));
  });

  it("enforces Camp Lejeune exposure dates (1953-1987)", () => {
    const resValid = validateTortClaim({
      tort_type: "camp-lejeune",
      diagnosis: "leukemia",
      exposure_start: "1970-01-01",
      exposure_end: "1975-01-01",
      location_name: "Base",
    });
    assert.strictEqual(resValid.valid, true);

    const resInvalid = validateTortClaim({
      tort_type: "camp-lejeune",
      diagnosis: "leukemia",
      exposure_start: "1990-01-01",
      exposure_end: "1995-01-01",
      location_name: "Base",
    });
    assert.strictEqual(resInvalid.valid, false);
    assert.ok(resInvalid.errors.includes("EXPOSURE_OUTSIDE_1953_1987"));
  });

  it("returns tort categories correctly", () => {
    const categories = getTortCategories();
    assert.ok(categories.length > 0);

    const pharma = categories.find((c) => c.category === "pharmaceutical");
    assert.ok(pharma);
    assert.ok(pharma.torts.some((t) => t.id === "roundup"));
  });
});
