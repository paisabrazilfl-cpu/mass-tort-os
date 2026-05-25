/**
 * Per-tort bg-hub lane policy.
 *
 * Why this exists. Not every tort needs every lane:
 *   - Roblox / Discord / Snap / Meta / Character.ai (child-safety
 *     torts): claimants are minors or guardians. NO medical-records
 *     lane, NO physician/NPI verification, NO incarceration check
 *     (children). Sex-offender-registry + address + identity matter.
 *   - Camp Lejeune / 3M earplug / Roundup / talc / hair-relaxer
 *     (traditional mass-tort): medical lanes are critical. Diagnosis,
 *     physician identity, exposure window all matter. Sex-offender is
 *     low-signal for these.
 *   - Securities / consumer-fraud class actions: business-entity lane
 *     matters most. Medical lanes irrelevant.
 *   - Data-breach / privacy: address + identity matter; medical does
 *     not.
 *
 * This module is the single source of truth for which lanes run for
 * a given tort, and how the final aggregator interprets skipped lanes.
 * `form_configurations.tort_type` (or the slug a form was submitted
 * under) is the lookup key.
 *
 * The defaults are conservative — when in doubt we run a lane and let
 * the operator dismiss it, rather than silently skip a check.
 */
import type { BackgroundLane } from "./types";

export type LanePolicy = "run" | "skip" | "advisory";

/**
 * Canonical bucket a tort falls into. Determines lane policy.
 * Edit this list as new torts onboard.
 */
export type TortCategory =
  | "medical_injury"        // Camp Lejeune, 3M, Roundup, talc, hair-relaxer
  | "child_safety"          // Roblox, Discord, Snap, Meta, Character.ai
  | "pharmaceutical_injury" // Zantac, Tylenol-autism, etc — has medical
  | "consumer_fraud"        // Class actions, false-advertising
  | "data_breach"           // T-Mobile, Equifax, etc.
  | "securities"            // 10b-5 class actions
  | "premises_liability"    // Slip-and-fall, building defect
  | "unknown";              // default — run everything

// Slug → category. Lowercase comparison. Adding a tort here is a
// one-line change; the policy table below decides the lanes.
const TORT_CATEGORY_BY_SLUG: ReadonlyMap<string, TortCategory> = new Map([
  // Medical / pharmaceutical injury
  ["camp_lejeune", "medical_injury"],
  ["camp-lejeune", "medical_injury"],
  ["3m_earplug", "medical_injury"],
  ["3m-earplug", "medical_injury"],
  ["roundup", "medical_injury"],
  ["paraquat", "medical_injury"],
  ["talc", "medical_injury"],
  ["talcum_powder", "medical_injury"],
  ["talcum-powder", "medical_injury"],
  ["hair_relaxer", "medical_injury"],
  ["hair-relaxer", "medical_injury"],
  ["pfas", "medical_injury"],
  ["zantac", "pharmaceutical_injury"],
  ["tylenol_autism", "pharmaceutical_injury"],
  ["tylenol-autism", "pharmaceutical_injury"],
  ["ozempic", "pharmaceutical_injury"],
  ["nec_baby_formula", "pharmaceutical_injury"],
  ["nec-baby-formula", "pharmaceutical_injury"],
  ["hernia_mesh", "medical_injury"],
  ["hernia-mesh", "medical_injury"],
  ["bard_powerport", "medical_injury"],

  // Child safety / social-media torts
  ["roblox", "child_safety"],
  ["discord", "child_safety"],
  ["snap", "child_safety"],
  ["snapchat", "child_safety"],
  ["meta", "child_safety"],
  ["facebook", "child_safety"],
  ["instagram", "child_safety"],
  ["character_ai", "child_safety"],
  ["character-ai", "child_safety"],
  ["tiktok", "child_safety"],
  ["youtube", "child_safety"],
  ["onlyfans", "child_safety"],
  ["social_media_addiction", "child_safety"],
  ["social-media-addiction", "child_safety"],

  // Data breach / privacy
  ["data_breach", "data_breach"],
  ["data-breach", "data_breach"],
  ["t_mobile_breach", "data_breach"],
  ["equifax_breach", "data_breach"],
  ["bipa", "data_breach"],

  // Consumer fraud / class actions
  ["false_advertising", "consumer_fraud"],
  ["consumer_fraud", "consumer_fraud"],
]);

export function categorizeTort(tortSlug: string | null | undefined): TortCategory {
  if (!tortSlug) return "unknown";
  const key = tortSlug.trim().toLowerCase().replace(/\s+/g, "_");
  return TORT_CATEGORY_BY_SLUG.get(key)
    ?? TORT_CATEGORY_BY_SLUG.get(key.replace(/_/g, "-"))
    ?? "unknown";
}

/**
 * Policy matrix. Each cell is one of:
 *   "run"       — execute the adapter, score the result.
 *   "skip"      — don't execute the adapter; the lane is OMITTED
 *                 entirely from the result. (Not NOT_RUN — those rows
 *                 don't appear in the response. Operator UI cleaner
 *                 because irrelevant lanes are invisible.)
 *   "advisory"  — execute the adapter but never let the result fail
 *                 the lead. Useful for low-signal lanes you want to
 *                 surface for awareness without gating intake on them.
 *
 * Reasoning per category:
 *   medical_injury: every lane is meaningful. Run all.
 *   pharmaceutical_injury: same as medical_injury; physician
 *     verification + criminal history matter.
 *   child_safety: claimants are minors or parents — DOB/identity
 *     checks against the lead's own info are wrong (parent's DOB ≠
 *     minor's DOB). NSOPW matters intensely (it's literally a
 *     sex-offender / online-predator screen on the BAD actor side,
 *     not the claimant side, but we still run it on lead identity
 *     for FCRA-safe reverse-screening). Skip incarceration of the
 *     parent claimant (low signal). Skip business-entity (irrelevant).
 *   consumer_fraud: identity matters, residency matters, NOT the
 *     medical-style lanes. Skip incarceration, NSOPW, attorney
 *     (unless it's a legal-malpractice subset).
 *   data_breach: identity + residency. Skip everything medical-style.
 *   securities: business-entity + attorney. Skip everything else.
 *   premises_liability: address (was the lead actually at the
 *     premises?), criminal_court (have they sued before?), residency.
 *     Skip business-entity unless premises was commercial.
 */
const POLICY_MATRIX: Record<TortCategory, Partial<Record<BackgroundLane, LanePolicy>>> = {
  medical_injury: {
    // default for unset lanes is "run" — see lanePolicyFor()
  },
  pharmaceutical_injury: {
    // identical to medical for now
  },
  child_safety: {
    // Run identity-style lanes against the *parent / submitter*, not
    // the child claimant. Skip lanes that don't make sense for minors.
    incarceration: "advisory",
    attorney: "skip",
    business_entity: "skip",
    pacer_federal: "advisory",
    // sex_offender_nsopw stays on — the platforms in these MDLs are
    // accused of failing to screen predators, and a registered sex
    // offender claimant on the *plaintiff* side is a meaningful audit
    // signal even if rare.
    residency: "advisory", // parents may have moved; not a fail signal
  },
  consumer_fraud: {
    incarceration: "skip",
    sex_offender_nsopw: "skip",
    attorney: "skip",
    pacer_federal: "advisory",
    residency: "advisory",
  },
  data_breach: {
    incarceration: "skip",
    sex_offender_nsopw: "skip",
    attorney: "skip",
    business_entity: "skip",
    pacer_federal: "skip",
    residency: "run", // address-of-breach association matters
  },
  securities: {
    incarceration: "skip",
    sex_offender_nsopw: "skip",
    residency: "skip",
    // attorney + business_entity are the high-value lanes here
  },
  premises_liability: {
    incarceration: "advisory",
    sex_offender_nsopw: "advisory",
    attorney: "skip",
    business_entity: "advisory",
    // criminal_court + residency + pacer_federal are core (prior PI
    // lawsuits = professional plaintiff signal)
  },
  unknown: {
    // Run everything when we don't know the tort. Safer than skipping.
  },
};

/**
 * What should we do with this lane for a tort of this category? Returns
 * "run" by default unless a category-specific override is set.
 */
export function lanePolicyFor(category: TortCategory, lane: BackgroundLane): LanePolicy {
  return POLICY_MATRIX[category][lane] ?? "run";
}

/** Convenience: list the lanes that will actually run for a tort. */
export function applicableLanesFor(category: TortCategory, allLanes: readonly BackgroundLane[]): BackgroundLane[] {
  return allLanes.filter((l) => lanePolicyFor(category, l) !== "skip");
}
