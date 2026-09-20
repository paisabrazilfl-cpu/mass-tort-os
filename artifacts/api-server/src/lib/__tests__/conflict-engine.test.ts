import { test } from "node:test";
import assert from "node:assert/strict";
import {
  checkLogicalConflicts,
  checkDataIntegrity,
  checkAIClassificationConflict,
  checkRuleOverrideConflict,
  ConflictCheckContext,
} from "../conflict-engine";

test("checkLogicalConflicts: accepts valid US location and matching tort condition", () => {
  const ctx: ConflictCheckContext = {
    entity_type: "lead",
    entity_id: "101",
    source_module: "test",
    lead_data: {
      location_name: "Austin, TX, USA",
      tort_type: "Camp Lejeune",
      diagnosis_type: "Non-Hodgkin Lymphoma and leukemia",
      exposure_start: "1980-01-01",
      exposure_end: "1985-12-31",
    },
  };

  const result = checkLogicalConflicts(ctx);
  assert.equal(result.has_conflict, false);
  assert.equal(result.output_state, "ACCEPT");
});

test("checkLogicalConflicts: flags invalid location, condition mismatch, and bad dates", () => {
  const ctx: ConflictCheckContext = {
    entity_type: "lead",
    entity_id: "102",
    source_module: "test",
    lead_data: {
      location: "Toronto, Canada",
      tort_type: "Roundup",
      diagnosis_type: "Asthma",
      exposure_start: "2020-01-01",
      exposure_end: "2010-01-01",
    },
  };

  const result = checkLogicalConflicts(ctx);
  assert.equal(result.has_conflict, true);
  assert.equal(result.conflict_type, "LOGICAL_CONFLICT");
  assert.equal(result.severity, "high");
  assert.equal(result.details.length, 3);
});

test("checkDataIntegrity: validates complete valid lead data", () => {
  const ctx: ConflictCheckContext = {
    entity_type: "lead",
    entity_id: "103",
    source_module: "test",
    lead_data: {
      name: "John Doe",
      tort_type: "Camp Lejeune",
      email: "john@example.com",
      phone: "(555) 019-2831",
    },
  };

  const result = checkDataIntegrity(ctx);
  assert.equal(result.has_conflict, false);
  assert.equal(result.output_state, "ACCEPT");
});

test("checkDataIntegrity: flags missing required fields and garbage input", () => {
  const ctx: ConflictCheckContext = {
    entity_type: "lead",
    entity_id: "104",
    source_module: "test",
    lead_data: {
      name: "AAAAAA",
      tort_type: "12345",
      email: "not-an-email",
      phone: "123",
    },
  };

  const result = checkDataIntegrity(ctx);
  assert.equal(result.has_conflict, true);
  assert.equal(result.conflict_type, "DATA_INTEGRITY_CONFLICT");
  assert.equal(result.output_state, "REJECT");
});

test("checkAIClassificationConflict: detects agreement and conflict", () => {
  const ctx: ConflictCheckContext = {
    entity_type: "lead",
    entity_id: "105",
    source_module: "test",
  };

  const match = checkAIClassificationConflict(
    { verdict: "strong", score: 0.9 },
    { qualified: true, status: "QUALIFIED" },
    ctx
  );
  assert.equal(match.has_conflict, false);

  const conflict = checkAIClassificationConflict(
    { verdict: "strong", score: 0.9 },
    { qualified: false, status: "DISQUALIFIED" },
    ctx
  );
  assert.equal(conflict.has_conflict, true);
  assert.equal(conflict.conflict_type, "AI_CLASSIFICATION_CONFLICT");
});

test("checkRuleOverrideConflict: checks location, age, and required conditions override", () => {
  const ctx: ConflictCheckContext = {
    entity_type: "lead",
    entity_id: "106",
    source_module: "test",
  };

  const valid = checkRuleOverrideConflict(
    { allowed_locations: ["TX", "CA"], min_age: 21, required_conditions: ["cancer"] },
    { allowed_locations: ["TX", "CA", "NY"], min_age: 18, required_conditions: ["cancer"] },
    ctx
  );
  assert.equal(valid.has_conflict, false);

  const invalid = checkRuleOverrideConflict(
    { allowed_locations: ["TX", "FL"], min_age: 16, required_conditions: [] },
    { allowed_locations: ["TX"], min_age: 18, required_conditions: ["cancer"] },
    ctx
  );
  assert.equal(invalid.has_conflict, true);
  assert.equal(invalid.conflict_type, "RULE_OVERRIDE_CONFLICT");
  assert.equal(invalid.details.length, 3);
});
