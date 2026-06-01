// Web-form field canonicalization (single source of truth).
//
// `forceFieldsRequired` makes every field on a web form mandatory. It is
// applied at BUILDER OUTPUT (so newly-built/seeded configs are all-required)
// AND at RENDER + VALIDATE time (so ALREADY-PUBLISHED forms — whose stored
// web_form_config baked in optional fields — also enforce all-required without
// a data migration), mirroring how `withCanonicalConsent` keeps consent copy
// current on existing forms.
//
// Conditional fields (those carrying a `show_if` predicate) are NOT forced to
// `required: true` here, because that would require them even when hidden.
// Instead the server validators evaluate `show_if` at submit time (see
// `conditionMet`) and require a conditional field ONLY when its condition is
// met — i.e. exactly when the field is visible — so every rendered field stays
// mandatory while hidden conditionals never trigger a false rejection.

import type { WebFormField, ShowIfCondition } from "@workspace/db";

/**
 * Force every non-conditional field to `required: true`. Fields already
 * required, and fields carrying a `show_if` predicate, pass through untouched
 * (conditionals are enforced dynamically via `conditionMet`).
 */
export function forceFieldsRequired(fields: WebFormField[]): WebFormField[] {
  return (fields ?? []).map((f) =>
    f.show_if || f.required ? f : { ...f, required: true },
  );
}

/**
 * Normalize a submitted value into the string form a `show_if` predicate is
 * compared against, mirroring the embed's `mtosFieldValue`: a checked checkbox
 * (boolean `true`, `"true"`, or FormData `"on"`) becomes `"true"`; null/empty
 * becomes `""`; everything else stringifies. The same normalization is used by
 * both the modern and legacy validators so server visibility matches the
 * browser exactly.
 */
export function normalizeConditionValue(raw: unknown): string {
  if (raw === true || raw === "true" || raw === "on") return "true";
  if (raw === false || raw === null || raw === undefined) return "";
  return String(raw);
}

/**
 * Deterministically evaluate a `show_if` predicate, mirroring the embed's
 * `mtosCondMet` operator semantics so the server agrees with the browser on
 * which conditional fields are visible (and therefore required). `getValue`
 * resolves the predicate's source field to its already-normalized string value.
 */
export function conditionMet(
  cond: ShowIfCondition,
  getValue: (key: string) => string,
): boolean {
  const v = getValue(cond.field);
  const t = cond.value;
  switch (cond.op) {
    case "eq":
      return Array.isArray(t) ? t.includes(v) : String(t) === v;
    case "ne":
      return Array.isArray(t) ? !t.includes(v) : String(t) !== v;
    case "in":
      return Array.isArray(t) ? t.includes(v) : false;
    case "not_in":
      return Array.isArray(t) ? !t.includes(v) : true;
    case "lt":
      return parseFloat(v) < parseFloat(String(t));
    case "gt":
      return parseFloat(v) > parseFloat(String(t));
    default:
      return true;
  }
}
