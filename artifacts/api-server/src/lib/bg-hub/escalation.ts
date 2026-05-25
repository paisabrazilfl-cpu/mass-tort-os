import type { BackgroundLane, BackgroundStatus } from "./types";

// Per-lane flag taxonomy. A lane's adapter emits flags from this vocabulary;
// the arbiter (statusFromFlags) maps the observed set to PASS / FAIL /
// REVIEW_REQUIRED. Keep this table small and explicit — drift between
// adapter-emitted flags and rules causes the "unknown_hits" branch to fire,
// which is REVIEW_REQUIRED on purpose so the operator notices.
export const BACKGROUND_ESCALATION_RULES: Record<
  BackgroundLane,
  { fail: readonly string[]; review: readonly string[] }
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

  phone_provenance: {
    fail: ["phone_provenance_fraud", "phone_provenance_stolen"],
    review: ["phone_provenance_not_checked", "phone_provenance_ported_recently", "phone_provenance_source_unavailable"],
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
      // OFAC sanctions check is a CONFIGURED source (gated on OFAC_API_KEY).
      // When it's skipped or unreachable we MUST escalate to REVIEW — a
      // configured source that wasn't actually checked must never resolve to
      // a silent PASS. See adaptCriminalCourt.
      "ofac_unavailable",
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

// Stub lanes are not yet fully implemented — their adapters may emit zero
// flags on an inconclusive run, which the arbiter must treat as REVIEW_REQUIRED
// rather than silently passing. Listed explicitly so adding a live adapter
// promotes a lane out of STUB_LANES in one place.
export const STUB_LANES: readonly BackgroundLane[] = [
  "residency",
  "attorney",
  "phone_provenance",
];

// Translate a set of observed flags into a status + score for one lane.
// Precedence is: any FAIL flag → FAIL; otherwise any REVIEW flag → REVIEW;
// otherwise any UNKNOWN flag → REVIEW (because we don't trust silent drift);
// stub lanes with zero flags → REVIEW_REQUIRED (never silently pass);
// otherwise PASS.
export function statusFromFlags(lane: BackgroundLane, flags: string[]): FlagEvaluation {
  const rules = BACKGROUND_ESCALATION_RULES[lane];
  if (!rules) {
    return {
      status: "REVIEW_REQUIRED",
      score: 50,
      notes: [`No escalation rule for lane "${lane}" — treated as review.`],
    };
  }
  const failHits = flags.filter((f) => rules.fail.includes(f));
  const reviewHits = flags.filter((f) => rules.review.includes(f));
  const unknownHits = flags.filter((f) => !rules.fail.includes(f) && !rules.review.includes(f));

  if (failHits.length === 0 && reviewHits.length === 0 && unknownHits.length === 0 && (STUB_LANES as readonly string[]).includes(lane)) {
    return {
      status: "REVIEW_REQUIRED",
      score: 50,
      notes: [`Stub lane "${lane}" — no adapter output; queued for manual review.`],
    };
  }
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
  return {
    status: "PASS",
    score: 100,
    notes: ["No adverse flags detected."],
  };
}
