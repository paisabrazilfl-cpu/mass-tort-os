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
  adaptResidency,
} from "./adapters";
import { BACKGROUND_SOURCES } from "./sources";
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

export async function runBackgroundCheckHub(lead: LeadLike): Promise<BackgroundHubResult> {
  // Run all adapters in parallel — they're independent and most are cheap
  // (the only network-bound one is criminal_court which calls CourtListener +
  // OFAC). Adapter exceptions are caught here as a safety net even though
  // each adapter already catches its own.
  const settled = await Promise.allSettled(ADAPTERS.map((a) => a.run(lead)));
  const results: BackgroundLaneResult[] = settled.map((s, i) => {
    const adapter = ADAPTERS[i]!;
    if (s.status === "fulfilled") return s.value;
    const err = s.reason;
    return {
      lane: adapter.lane,
      status: "REVIEW_REQUIRED",
      score: 40,
      flags: ["adapter_exception"],
      notes: [`Adapter failed safely: ${err instanceof Error ? err.message : String(err)}`],
      sources: [...BACKGROUND_SOURCES[adapter.lane]],
      checked_at: new Date().toISOString(),
      error: err instanceof Error ? (err.stack ?? err.message) : String(err),
    };
  });

  const summary = {
    pass: results.filter((r) => r.status === "PASS").length,
    review_required: results.filter((r) => r.status === "REVIEW_REQUIRED").length,
    fail: results.filter((r) => r.status === "FAIL").length,
    not_run: results.filter((r) => r.status === "NOT_RUN").length,
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
    overall_score: overallScore,
    checked_at: new Date().toISOString(),
    summary,
    results,
  };
}
