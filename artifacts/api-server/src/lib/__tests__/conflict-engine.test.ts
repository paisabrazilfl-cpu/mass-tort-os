process.env["DATABASE_URL"] = process.env["DATABASE_URL"] || "postgres://localhost:5432/test";

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  checkLogicalConflicts,
  checkDataIntegrity,
  checkAIClassificationConflict,
  checkRuleOverrideConflict,
} from "../conflict-engine";

test("checkLogicalConflicts: valid US location and known tort diagnosis passes", () => {
  const result = checkLogicalConflicts({
    entity_type: "lead",
    entity_id: "test_1",
    source_module: "test",
    lead_data: {
      location: "Raleigh, NC",
      tort_type: "Camp Lejeune",
      diagnosis_type: "Kidney Disease",
      exposure_start: "1982-01-01",
      exposure_end: "1985-06-30",
    },
  });

  assert.equal(result.has_conflict, false);
  assert.equal(result.output_state, "ACCEPT");
  assert.equal(result.details.length, 0);
  assert.equal(result.severity, "low");
});

test("checkLogicalConflicts: outside US location produces conflict", () => {
  const result = checkLogicalConflicts({
    entity_type: "lead",
    entity_id: "test_2",
    source_module: "test",
    lead_data: {
      location: "London, UK",
    },
  });

  assert.equal(result.has_conflict, true);
  assert.equal(result.conflict_type, "LOGICAL_CONFLICT");
  assert.equal(result.output_state, "REVIEW_REQUIRED");
  assert.ok(result.details.some((d) => d.includes("outside allowed US geography")));
});

test("checkLogicalConflicts: mismatched tort diagnosis produces conflict", () => {
  const result = checkLogicalConflicts({
    entity_type: "lead",
    entity_id: "test_3",
    source_module: "test",
    lead_data: {
      tort_type: "Roundup",
      diagnosis_type: "Broken arm",
    },
  });

  assert.equal(result.has_conflict, true);
  assert.equal(result.conflict_type, "LOGICAL_CONFLICT");
  assert.ok(result.details.some((d) => d.includes("does not match known conditions")));
});

test("checkLogicalConflicts: exposure start after end produces conflict", () => {
  const result = checkLogicalConflicts({
    entity_type: "lead",
    entity_id: "test_4",
    source_module: "test",
    lead_data: {
      exposure_start: "2020-01-01",
      exposure_end: "2015-01-01",
    },
  });

  assert.equal(result.has_conflict, true);
  assert.ok(result.details.some((d) => d.includes("is after end date")));
});

test("checkDataIntegrity: valid lead passes with no conflict", () => {
  const result = checkDataIntegrity({
    entity_type: "lead",
    entity_id: "test_5",
    source_module: "test",
    lead_data: {
      name: "Alice Johnson",
      tort_type: "Roundup",
      email: "alice@example.com",
      phone: "(555) 234-5678",
    },
  });

  assert.equal(result.has_conflict, false);
  assert.equal(result.output_state, "ACCEPT");
  assert.equal(result.severity, "low");
});

test("checkDataIntegrity: missing required fields flags critical conflict", () => {
  const result = checkDataIntegrity({
    entity_type: "lead",
    entity_id: "test_6",
    source_module: "test",
    lead_data: {},
  });

  assert.equal(result.has_conflict, true);
  assert.equal(result.conflict_type, "DATA_INTEGRITY_CONFLICT");
  assert.equal(result.severity, "critical");
  assert.equal(result.output_state, "REVIEW_REQUIRED");
  assert.ok(result.details.some((d) => d.includes('Required field "name"')));
  assert.ok(result.details.some((d) => d.includes('Required field "tort_type"')));
});

test("checkDataIntegrity: garbage name and garbage tort triggers REJECT", () => {
  const result = checkDataIntegrity({
    entity_type: "lead",
    entity_id: "test_7",
    source_module: "test",
    lead_data: {
      name: "aaaaa",
      tort_type: "12345",
      email: "test@example.com",
      phone: "5551234567",
    },
  });

  assert.equal(result.has_conflict, true);
  assert.equal(result.conflict_type, "DATA_INTEGRITY_CONFLICT");
  assert.equal(result.severity, "critical");
  assert.equal(result.failsafe_mode, "SAFE_FAIL");
  assert.equal(result.output_state, "REJECT");
  assert.ok(result.details.some((d) => d.includes("appears to be garbage input")));
});

test("checkDataIntegrity: invalid email and too short phone flagged", () => {
  const result = checkDataIntegrity({
    entity_type: "lead",
    entity_id: "test_8",
    source_module: "test",
    lead_data: {
      name: "Valid Name",
      tort_type: "Roundup",
      email: "invalid-email-no-at",
      phone: "12345",
    },
  });

  assert.equal(result.has_conflict, true);
  assert.equal(result.output_state, "REVIEW_REQUIRED");
  assert.ok(result.details.some((d) => d.includes("Email")));
  assert.ok(result.details.some((d) => d.includes("Phone")));
});

test("checkAIClassificationConflict: agreement produces no conflict", () => {
  const matchPass = checkAIClassificationConflict(
    { verdict: "strong", score: 90 },
    { qualified: true, status: "QUALIFIED" },
    { entity_type: "lead", entity_id: "t1", source_module: "test" }
  );
  assert.equal(matchPass.has_conflict, false);
  assert.equal(matchPass.output_state, "ACCEPT");

  const matchFail = checkAIClassificationConflict(
    { verdict: "weak", score: 20 },
    { qualified: false, status: "DISQUALIFIED" },
    { entity_type: "lead", entity_id: "t2", source_module: "test" }
  );
  assert.equal(matchFail.has_conflict, false);
  assert.equal(matchFail.output_state, "REJECT");
});

test("checkAIClassificationConflict: disagreement produces conflict", () => {
  const conflict = checkAIClassificationConflict(
    { verdict: "strong", score: 95 },
    { qualified: false, status: "DISQUALIFIED" },
    { entity_type: "lead", entity_id: "t3", source_module: "test" }
  );
  assert.equal(conflict.has_conflict, true);
  assert.equal(conflict.conflict_type, "AI_CLASSIFICATION_CONFLICT");
  assert.equal(conflict.severity, "high");
  assert.equal(conflict.output_state, "REVIEW_REQUIRED");
});

test("checkRuleOverrideConflict: location and age mismatches flagged", () => {
  const conflict = checkRuleOverrideConflict(
    { allowed_locations: ["NY", "CA", "UK"], min_age: 18, required_conditions: ["asthma"] },
    { allowed_locations: ["NY", "CA"], min_age: 21, required_conditions: ["cancer"] },
    { entity_type: "buyer", entity_id: "b1", source_module: "test" }
  );

  assert.equal(conflict.has_conflict, true);
  assert.equal(conflict.conflict_type, "RULE_OVERRIDE_CONFLICT");
  assert.equal(conflict.severity, "high");
  assert.equal(conflict.failsafe_mode, "HARD_BLOCK");
  assert.ok(conflict.details.some((d) => d.includes("Buyer criteria allows locations")));
  assert.ok(conflict.details.some((d) => d.includes("Buyer min_age")));
  assert.ok(conflict.details.some((d) => d.includes("Global required condition")));
});
