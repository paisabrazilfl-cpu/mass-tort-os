import type { BackgroundLane, BackgroundStatus } from "./types";

// Per-lane flag taxonomy. A lane's adapter emits flags from this vocabulary;
// the arbiter (statusFromFlags) maps the observed set to PASS / FAIL /
// REVIEW_REQUIRED / NOT_RUN. Keep this table small and explicit — drift
// between adapter-emitted flags and rules causes the "unknown_hits"
// branch to fire, which is REVIEW_REQUIRED on purpose so the operator
// notices.
//
// Categories:
//   fail   — hard adverse signal. Lane resolves FAIL immediately.
//   review — non-decisive signal. Lane resolves REVIEW_REQUIRED.
//   skip   — adapter deliberately skipped (e.g. sub-source not
//            configured, irrelevant for this lead). If a lane emits
//            ONLY skip flags, it resolves NOT_RUN so the UI distinguishes
//            "we didn't run this" from "we ran it and it needs review."
//            Skip flags combined with review/fail flags lose to the
//            stronger signal.
export const BACKGROUND_ESCALATION_RULES: Record<
  BackgroundLane,
  { fail: readonly string[]; review: readonly string[]; skip?: readonly string[] }
> = {
  address: {
    fail: [
      "missing_address",
      "missing_street",
      "invalid_street_format",
      "missing_city",
      "invalid_city",
      "missing_state",
      "invalid_state_code",
      "missing_zip",
      "invalid_zip_format",
      "garbage_address_data",
    ],
    review: ["address_not_checked", "partial_address_match", "source_unavailable"],
  },

  email: {
    fail: ["missing_email", "invalid_email_format", "no_mx_records", "disposable_domain"],
    review: ["email_not_checked", "role_based_email", "smtp_not_checked", "typo_suggestion"],
  },

  phone: {
    fail: ["missing_phone", "invalid_phone_format", "number_disconnected"],
    review: ["phone_not_checked", "voip", "prepaid", "carrier_unknown"],
  },

  residency: {
    fail: ["hard_address_mismatch"],
    review: ["residency_not_checked", "no_residency_corroboration"],
  },

  criminal_court: {
    fail: [
      "confirmed_criminal_match",
      "fraud_record_found",
      "theft_record_found",
      "violent_record_found",
    ],
    review: [
      "court_check_not_run",
      "ambiguous_case_match",
      "similar_name_match",
      "court_records_found_review",
      "court_source_unreachable",
      // OFAC unreachable at run-time (network error, provider returned 5xx)
      // → REVIEW: we tried, we got nothing, operator should look. This is
      // distinct from `ofac_unconfigured` which routes to NOT_RUN below.
      "ofac_unavailable",
    ],
    skip: [
      // OFAC was deliberately skipped because the source isn't configured
      // (legacy paid path with no OFAC_API_KEY AND Treasury disabled). Pre-
      // flight signal — different from "we tried and failed." If the lane
      // has NO other flags, this resolves NOT_RUN so the operator
      // distinguishes a missing-key install from a genuinely-needs-review
      // lead. With the Treasury free path enabled (default), this branch
      // is essentially unreachable.
      "ofac_unconfigured",
    ],
  },

  incarceration: {
    fail: ["active_incarceration"],
    review: ["incarceration_check_not_run", "possible_custody_match"],
  },

  sex_offender_nsopw: {
    fail: ["confirmed_registry_match"],
    review: [
      "nsopw_manual_check_required",
      "possible_registry_match",
      "source_unavailable",
    ],
  },

  attorney: {
    fail: ["bar_suspended", "bar_inactive", "bar_not_found"],
    review: ["attorney_not_checked", "discipline_possible", "manual_bar_check_required"],
  },

  business_entity: {
    fail: ["entity_dissolved", "registration_inactive", "no_business_filing_found"],
    review: [
      "business_not_checked",
      "entity_name_partial_match",
      "manual_entity_check_required",
    ],
  },

  // PACER federal courts (PCL Search API). Hard FAIL is reserved for
  // operator-confirmed criminal matches surfaced after manual review of the
  // returned docket; the live adapter never auto-FAILs on a name hit because
  // PCL returns party names without identity-confirming metadata.
  //
  // The `pacer_not_configured`, `pacer_auth_failed`, and
  // `pacer_source_unreachable` flags route to NOT_RUN (handled directly in
  // adaptPacer, bypassing this taxonomy) — PACER is opt-in (per-page billing)
  // and a service or auth failure is reported honestly as "we did not run
  // this lane" with the underlying reason, NOT as a manual review queue.
  pacer_federal: {
    fail: ["pacer_confirmed_criminal_match"],
    review: [
      "pacer_records_found_review",
      "pacer_active_criminal_docket",
    ],
  },
};

export interface FlagEvaluation {
  status: BackgroundStatus;
  score: number;
  notes: string[];
}

// Lanes with no live data adapter today (lib/bg-hub/adapters.ts "honest stub"
// markers). These can never return a clean PASS — even when their adapter
// emits zero flags we force REVIEW_REQUIRED so a buyer cannot misread an
// all-green badge cluster as automated clearance. If you add a real adapter
// for one of these lanes, REMOVE its entry from this set and let the normal
// flag taxonomy decide.
//
// business_entity is NOT in this set anymore: it has a live SEC EDGAR
// adapter (lib/bg-hub/sec-edgar.ts). EDGAR covers public companies + large
// LLCs + Reg-D filers (~10 K entities). When EDGAR returns a hit the
// lane resolves PASS via the normal taxonomy. When EDGAR returns no hit
// the adapter still emits `manual_entity_check_required` → REVIEW so
// small unregistered entities aren't silently cleared.
export const STUB_LANES: ReadonlySet<BackgroundLane> = new Set([
  "residency",
  "incarceration",
  "sex_offender_nsopw",
  "attorney",
]);

// Translate a set of observed flags into a status + score for one lane.
// Precedence is: any FAIL flag → FAIL; otherwise any REVIEW flag → REVIEW;
// otherwise any UNKNOWN flag → REVIEW (because we don't trust silent drift);
// otherwise PASS — UNLESS the lane is in STUB_LANES, in which case the best
// achievable status is REVIEW_REQUIRED.
export function statusFromFlags(lane: BackgroundLane, flags: string[]): FlagEvaluation {
  const rules = BACKGROUND_ESCALATION_RULES[lane];
  if (!rules) {
    return {
      status: "REVIEW_REQUIRED",
      score: 50,
      notes: [`No escalation rule for lane "${lane}" — treated as review.`],
    };
  }
  const skipList = rules.skip ?? [];
  const failHits = flags.filter((f) => rules.fail.includes(f));
  const reviewHits = flags.filter((f) => rules.review.includes(f));
  const skipHits = flags.filter((f) => skipList.includes(f));
  const unknownHits = flags.filter(
    (f) => !rules.fail.includes(f) && !rules.review.includes(f) && !skipList.includes(f),
  );

  if (failHits.length > 0) {
    return {
      status: "FAIL",
      score: 0,
      notes: [`Hard failure: ${failHits.join(", ")}`],
    };
  }
  if (reviewHits.length > 0) {
    return {
      status: "REVIEW_REQUIRED",
      score: 50,
      notes: [`Manual review required: ${reviewHits.join(", ")}`],
    };
  }
  if (unknownHits.length > 0) {
    return {
      status: "REVIEW_REQUIRED",
      score: 60,
      notes: [`Unknown flags require review: ${unknownHits.join(", ")}`],
    };
  }
  if (skipHits.length > 0) {
    // Only skip flags present — the lane's sub-source was deliberately
    // not run. Report NOT_RUN so the operator can distinguish "config
    // gap" from "needs review." Score reflects the gap, not a clean
    // outcome.
    return {
      status: "NOT_RUN",
      score: 40,
      notes: [`Sub-source skipped: ${skipHits.join(", ")}`],
    };
  }
  if (STUB_LANES.has(lane)) {
    // Defense in depth. A stub-lane adapter that returned an empty flag
    // array would otherwise resolve to PASS via the line below. Force
    // REVIEW so the operator is always prompted to run the manual lookup.
    return {
      status: "REVIEW_REQUIRED",
      score: 50,
      notes: ["No live data adapter for this lane — manual operator lookup required."],
    };
  }
  return {
    status: "PASS",
    score: 100,
    notes: ["No adverse flags detected."],
  };
}
