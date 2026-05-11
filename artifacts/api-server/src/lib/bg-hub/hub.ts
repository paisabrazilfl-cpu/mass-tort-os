import {
  adaptAddress,
  adaptAttorney,
  adaptBusiness,
  adaptCriminalCourt,
  adaptEmail,
  adaptIncarceration,
  adaptNSOPW,
  adaptPacer,
  adaptPhone,
  adaptPhoneProvenance,
  adaptResidency,
} from "./adapters";
import { STUB_LANES } from "./escalation";
import { BACKGROUND_SOURCES } from "./sources";
import { categorizeTort, lanePolicyFor, type TortCategory } from "./tort-policy";
import {
  BG_HUB_VERSION,
  type BackgroundHubResult,
  type BackgroundLane,
  type BackgroundLaneResult,
  type BackgroundStatus,
  type LeadLike,
} from "./types";

interface AdapterEntry {
  lane: BackgroundLane;
  run: (lead: LeadLike) => Promise<BackgroundLaneResult>;
}

const ADAPTERS: readonly AdapterEntry[] = [
  { lane: "address", run: adaptAddress },
  { lane: "email", run: adaptEmail },
  { lane: "phone", run: adaptPhone },
  { lane: "phone_provenance", run: adaptPhoneProvenance },
  { lane: "residency", run: adaptResidency },
  { lane: "criminal_court", run: adaptCriminalCourt },
  { lane: "incarceration", run: adaptIncarceration },
  { lane: "sex_offender_nsopw", run: adaptNSOPW },
  { lane: "attorney", run: adaptAttorney },
  { lane: "business_entity", run: adaptBusiness },
  { lane: "pacer_federal", run: adaptPacer },
];

// Aggregate per-lane statuses into a single decision. Precedence:
//   any FAIL → FAIL
//   any REVIEW_REQUIRED → REVIEW_REQUIRED
//   any NOT_RUN → REVIEW_REQUIRED (cautious — operator should confirm)
//   all PASS → PASS
//
// We deliberately don't downgrade NOT_RUN to PASS even though the lane was
// skipped on purpose (e.g. business_entity with no business name). The Hub's
// final status reflects "is this lead fully cleared" — and "we didn't even
// look" never counts as cleared.
function getFinalStatus(results: readonly BackgroundLaneResult[]): BackgroundStatus {
  if (results.some((r) => r.status === "FAIL")) return "FAIL";
  if (results.some((r) => r.status === "REVIEW_REQUIRED")) return "REVIEW_REQUIRED";
  if (results.some((r) => r.status === "NOT_RUN")) return "REVIEW_REQUIRED";
  return "PASS";
}

export async function runBackgroundCheckHub(
  lead: LeadLike,
  opts: { tortSlug?: string | null } = {},
): Promise<BackgroundHubResult> {
  // Tort-aware lane gating. Not every tort needs every lane —
  // child-safety torts (Roblox / Discord / Snap) have no physician;
  // securities cases don't care about NSOPW; data-breach cases don't
  // need incarceration. See lib/bg-hub/tort-policy.ts for the matrix.
  // When the policy says "skip" for a lane, we drop it entirely from
  // the response. "advisory" runs the lane but stamps the result so
  // the final aggregator never escalates it to REVIEW/FAIL on its own.
  const tortCategory: TortCategory = categorizeTort(opts.tortSlug ?? null);
  const enabledAdapters = ADAPTERS.filter((a) => lanePolicyFor(tortCategory, a.lane) !== "skip");

  // Run all adapters in parallel — they're independent and most are cheap
  // (the only network-bound ones are criminal_court, phone_provenance,
  // and business_entity which call CourtListener / Telnyx / SEC EDGAR
  // respectively). Adapter exceptions are caught here as a safety net
  // even though each adapter already catches its own.
  const settled = await Promise.allSettled(enabledAdapters.map((a) => a.run(lead)));
  const results: BackgroundLaneResult[] = settled.map((s, i) => {
    const adapter = enabledAdapters[i]!;
    const policy = lanePolicyFor(tortCategory, adapter.lane);
    const baseResult: BackgroundLaneResult = (() => {
      if (s.status === "fulfilled") return s.value;
      const err = s.reason;
      return {
        lane: adapter.lane,
        status: "REVIEW_REQUIRED" as const,
        score: 40,
        flags: ["adapter_exception"],
        notes: [`Adapter failed safely: ${err instanceof Error ? err.message : String(err)}`],
        sources: [...BACKGROUND_SOURCES[adapter.lane]],
        checked_at: new Date().toISOString(),
        error: err instanceof Error ? (err.stack ?? err.message) : String(err),
      };
    })();
    // Advisory lanes are run but never gate intake. We downgrade
    // any REVIEW/FAIL to NOT_RUN so the aggregator treats them as
    // informational; the underlying flags and notes are preserved
    // so an operator can still read them.
    if (policy === "advisory" && (baseResult.status === "REVIEW_REQUIRED" || baseResult.status === "FAIL")) {
      return {
        ...baseResult,
        status: "NOT_RUN" as const,
        notes: [
          ...baseResult.notes,
          `Lane marked advisory for tort category "${tortCategory}" — informational only, does not gate intake.`,
        ],
      };
    }
    return baseResult;
  });

  // Live lanes = the ones with a real data adapter today. Stub lanes
  // (residency, incarceration, NSOPW, attorney, business_entity) are
  // structurally REVIEW_REQUIRED forever per escalation.ts's STUB_LANES
  // pin — so including them in any "all automated checks cleared" signal
  // means that signal can never be PASS. Split the aggregate so the
  // operator UI can render "automated checks: PASS" while still showing
  // "full clearance still needs manual lookups" in the stub-lane band.
  const liveLaneResults = results.filter((r) => !STUB_LANES.has(r.lane));

  const summary = {
    pass: results.filter((r) => r.status === "PASS").length,
    review_required: results.filter((r) => r.status === "REVIEW_REQUIRED").length,
    fail: results.filter((r) => r.status === "FAIL").length,
    not_run: results.filter((r) => r.status === "NOT_RUN").length,
    live_lanes_total: liveLaneResults.length,
    live_lanes_pass: liveLaneResults.filter((r) => r.status === "PASS").length,
    live_lanes_review: liveLaneResults.filter((r) => r.status === "REVIEW_REQUIRED").length,
    live_lanes_fail: liveLaneResults.filter((r) => r.status === "FAIL").length,
    live_lanes_not_run: liveLaneResults.filter((r) => r.status === "NOT_RUN").length,
  };

  // Average score, treating NOT_RUN as 0. This is a deliberate choice: the
  // overall_score should drop when lanes are skipped, not be inflated by
  // ignoring them.
  const overallScore =
    results.length > 0
      ? Math.round(results.reduce((sum, r) => sum + r.score, 0) / results.length)
      : 0;

  return {
    lead_id: lead.id,
    version: BG_HUB_VERSION,
    final_status: getFinalStatus(results),
    final_status_live_lanes_only: getFinalStatus(liveLaneResults),
    overall_score: overallScore,
    checked_at: new Date().toISOString(),
    summary,
    results,
  };
}
