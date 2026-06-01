// Regression coverage for the shared server-side show_if evaluator that backs
// "all fields mandatory in both forms". Both the modern web-form validator and
// the legacy embed pipeline decide whether a conditional field is required by
// calling conditionMet(show_if, getValue) — a field is required only when its
// condition is currently met (i.e. it would be visible in the browser). These
// tests pin the operator semantics to the embed's mtosCondMet and the value
// normalization to the embed's mtosFieldValue so server visibility can never
// drift from what the browser renders (a drift would either falsely reject a
// hidden field or silently let a visible required field be bypassed).

import { test } from "node:test";
import assert from "node:assert/strict";
import type { ShowIfCondition } from "@workspace/db";
import { conditionMet, normalizeConditionValue } from "../web-form-fields.js";

test("normalizeConditionValue mirrors embed mtosFieldValue checkbox/empty handling", () => {
  // Checked checkbox in all the shapes it can arrive as -> "true".
  assert.equal(normalizeConditionValue(true), "true");
  assert.equal(normalizeConditionValue("true"), "true");
  assert.equal(normalizeConditionValue("on"), "true");
  // Unchecked / absent -> "".
  assert.equal(normalizeConditionValue(false), "");
  assert.equal(normalizeConditionValue(null), "");
  assert.equal(normalizeConditionValue(undefined), "");
  // Everything else stringifies.
  assert.equal(normalizeConditionValue("2 yrs"), "2 yrs");
  assert.equal(normalizeConditionValue(3), "3");
});

test("conditionMet: eq / ne against a scalar target", () => {
  const eq: ShowIfCondition = { field: "dur", op: "eq", value: "2 yrs" };
  assert.equal(conditionMet(eq, () => "2 yrs"), true);
  assert.equal(conditionMet(eq, () => "<1 yr"), false);

  const ne: ShowIfCondition = { field: "dur", op: "ne", value: "<1 yr" };
  assert.equal(conditionMet(ne, () => "2 yrs"), true);
  assert.equal(conditionMet(ne, () => "<1 yr"), false);
});

test("conditionMet: eq / ne against an array target (membership)", () => {
  const eq: ShowIfCondition = { field: "x", op: "eq", value: ["a", "b"] };
  assert.equal(conditionMet(eq, () => "a"), true);
  assert.equal(conditionMet(eq, () => "c"), false);

  const ne: ShowIfCondition = { field: "x", op: "ne", value: ["a", "b"] };
  assert.equal(conditionMet(ne, () => "c"), true);
  assert.equal(conditionMet(ne, () => "a"), false);
});

test("conditionMet: in / not_in require an array target", () => {
  const inOp: ShowIfCondition = { field: "x", op: "in", value: ["a", "b"] };
  assert.equal(conditionMet(inOp, () => "a"), true);
  assert.equal(conditionMet(inOp, () => "z"), false);
  // Scalar target with `in` is treated as no-match (never visible).
  const inScalar: ShowIfCondition = { field: "x", op: "in", value: "a" };
  assert.equal(conditionMet(inScalar, () => "a"), false);

  const notIn: ShowIfCondition = { field: "x", op: "not_in", value: ["a", "b"] };
  assert.equal(conditionMet(notIn, () => "z"), true);
  assert.equal(conditionMet(notIn, () => "a"), false);
  // Scalar target with `not_in` is vacuously true (always visible).
  const notInScalar: ShowIfCondition = { field: "x", op: "not_in", value: "a" };
  assert.equal(conditionMet(notInScalar, () => "a"), true);
});

test("conditionMet: lt / gt parse numerically", () => {
  const lt: ShowIfCondition = { field: "age", op: "lt", value: 18 };
  assert.equal(conditionMet(lt, () => "17"), true);
  assert.equal(conditionMet(lt, () => "18"), false);
  assert.equal(conditionMet(lt, () => "21"), false);

  const gt: ShowIfCondition = { field: "age", op: "gt", value: 65 };
  assert.equal(conditionMet(gt, () => "70"), true);
  assert.equal(conditionMet(gt, () => "65"), false);
  assert.equal(conditionMet(gt, () => "40"), false);
});

test("conditionMet: a checked checkbox source drives a dependent's visibility", () => {
  // Conditional field shown only when the gating checkbox is checked.
  const cond: ShowIfCondition = { field: "was_at_location", op: "eq", value: "true" };
  const checked = (k: string) => normalizeConditionValue({ was_at_location: "on" }[k]);
  const unchecked = (k: string) => normalizeConditionValue({ was_at_location: false }[k as "was_at_location"]);
  assert.equal(conditionMet(cond, checked), true);
  assert.equal(conditionMet(cond, unchecked), false);
});
