import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  checkLogicalConflicts,
  checkDataIntegrity,
  checkAIClassificationConflict,
  checkRuleOverrideConflict,
  ConflictCheckContext,
} from "../conflict-engine";

describe("conflict-engine", () => {
  describe("checkLogicalConflicts", () => {
    test("passes valid US location, valid diagnosis, valid exposure dates", () => {
      const ctx: ConflictCheckContext = {
        entity_type: "lead",
        entity_id: "l1",
        source_module: "test",
        lead_data: {
          location: "Austin, TX",
          tort_type: "Camp Lejeune",
          diagnosis_type: "Kidney Disease",
          exposure_start: "1982-01-01",
          exposure_end: "1985-01-01",
        },
      };
      const res = checkLogicalConflicts(ctx);
      assert.equal(res.has_conflict, false);
      assert.equal(res.output_state, "ACCEPT");
    });

    test("detects non-US location", () => {
      const ctx: ConflictCheckContext = {
        entity_type: "lead",
        entity_id: "l1",
        source_module: "test",
        lead_data: {
          location: "Toronto, Canada",
        },
      };
      const res = checkLogicalConflicts(ctx);
      assert.equal(res.has_conflict, true);
      assert.ok(res.details[0]?.includes("outside allowed US geography"));
    });

    test("detects diagnosis mismatch for known tort", () => {
      const ctx: ConflictCheckContext = {
        entity_type: "lead",
        entity_id: "l1",
        source_module: "test",
        lead_data: {
          tort_type: "Roundup",
          diagnosis_type: "Broken Leg",
        },
      };
      const res = checkLogicalConflicts(ctx);
      assert.equal(res.has_conflict, true);
      assert.ok(res.details[0]?.includes("does not match known conditions"));
    });

    test("detects exposure start date after end date", () => {
      const ctx: ConflictCheckContext = {
        entity_type: "lead",
        entity_id: "l1",
        source_module: "test",
        lead_data: {
          exposure_start: "2020-01-01",
          exposure_end: "2010-01-01",
        },
      };
      const res = checkLogicalConflicts(ctx);
      assert.equal(res.has_conflict, true);
      assert.ok(res.details[0]?.includes("is after end date"));
    });
  });

  describe("checkDataIntegrity", () => {
    test("passes valid lead data", () => {
      const ctx: ConflictCheckContext = {
        entity_type: "lead",
        entity_id: "l1",
        source_module: "test",
        lead_data: {
          name: "John Smith",
          tort_type: "Camp Lejeune",
          email: "john@example.com",
          phone: "5125550199",
        },
      };
      const res = checkDataIntegrity(ctx);
      assert.equal(res.has_conflict, false);
      assert.equal(res.output_state, "ACCEPT");
    });

    test("detects missing required fields", () => {
      const ctx: ConflictCheckContext = {
        entity_type: "lead",
        entity_id: "l1",
        source_module: "test",
        lead_data: {},
      };
      const res = checkDataIntegrity(ctx);
      assert.equal(res.has_conflict, true);
      assert.equal(res.severity, "critical");
    });

    test("detects garbage name or tort type", () => {
      const ctx: ConflictCheckContext = {
        entity_type: "lead",
        entity_id: "l1",
        source_module: "test",
        lead_data: {
          name: "aaaaa",
          tort_type: "12345",
        },
      };
      const res = checkDataIntegrity(ctx);
      assert.equal(res.has_conflict, true);
      assert.equal(res.output_state, "REJECT");
    });

    test("detects invalid email and phone", () => {
      const ctx: ConflictCheckContext = {
        entity_type: "lead",
        entity_id: "l1",
        source_module: "test",
        lead_data: {
          name: "Jane Smith",
          tort_type: "Roundup",
          email: "notanemail",
          phone: "123",
        },
      };
      const res = checkDataIntegrity(ctx);
      assert.equal(res.has_conflict, true);
      assert.equal(res.severity, "medium");
    });
  });

  describe("checkAIClassificationConflict", () => {
    test("no conflict when both AI and rules agree", () => {
      const ctx: ConflictCheckContext = { entity_type: "lead", entity_id: "l1", source_module: "test" };
      const res = checkAIClassificationConflict(
        { verdict: "strong", score: 85 },
        { qualified: true, status: "qualified" },
        ctx
      );
      assert.equal(res.has_conflict, false);
    });

    test("conflict when AI accepts but rules reject", () => {
      const ctx: ConflictCheckContext = { entity_type: "lead", entity_id: "l1", source_module: "test" };
      const res = checkAIClassificationConflict(
        { verdict: "strong", score: 85 },
        { qualified: false, status: "disqualified" },
        ctx
      );
      assert.equal(res.has_conflict, true);
      assert.equal(res.conflict_type, "AI_CLASSIFICATION_CONFLICT");
    });
  });

  describe("checkRuleOverrideConflict", () => {
    test("detects location, age, and condition override conflicts", () => {
      const ctx: ConflictCheckContext = { entity_type: "lead", entity_id: "l1", source_module: "test" };
      const buyerCriteria = {
        allowed_locations: ["TX", "CA", "MX"],
        min_age: 18,
        required_conditions: ["Cancer"],
      };
      const globalTortRules = {
        allowed_locations: ["TX", "CA"],
        min_age: 21,
        required_conditions: ["Cancer", "Exposure"],
      };
      const res = checkRuleOverrideConflict(buyerCriteria, globalTortRules, ctx);
      assert.equal(res.has_conflict, true);
      assert.equal(res.conflict_type, "RULE_OVERRIDE_CONFLICT");
      assert.equal(res.details.length, 3);
    });
  });
});
