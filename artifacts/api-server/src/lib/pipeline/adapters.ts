/**
 * Pipeline adapter seams.
 *
 * The state machine is deterministic, but two stages depend on external
 * verdicts: the background check (BG_CHECK_PENDING) and provider verification
 * (NPI_PENDING). Rather than wire the state machine directly to one concrete
 * implementation, we route through thin adapter seams so the provider is
 * selectable by env and the rest of the pipeline depends only on a stable
 * verdict shape.
 *
 * Today both default to the live in-repo implementations:
 *   - background check  → `runBackgroundCheckHub` (10-lane bg-hub)
 *   - NPI verification  → `verifyProvider` (live NPPES)
 *
 * An external background-check vendor is supported as a SEAM only: set
 * `BG_CHECK_PROVIDER=external` and the worker will NOT run the hub — it parks
 * the lead at BG_CHECK_PENDING awaiting the vendor's signed callback at
 * `/api/webhooks/bgcheck`. We ship no vendor API keys, so `external` is a
 * documented integration point, not a live path (see the evidence report).
 */
import {
  verifyProvider,
  type VerifyProviderInput,
  type VerifyProviderResult,
  type VerifyProviderStatus,
} from "../npi-verify.js";
import { runBackgroundCheckHub } from "../bg-hub/hub.js";
import type { BackgroundHubResult, BackgroundStatus, LeadLike } from "../bg-hub/types.js";

// ---------------------------------------------------------------------------
// Background-check adapter
// ---------------------------------------------------------------------------

/** Pipeline-facing verdict. REVIEW means "do not auto-advance, operator must look". */
export type BgVerdict = "CLEAR" | "FAILED" | "REVIEW";

export interface BgCheckOutcome {
  verdict: BgVerdict;
  finalStatus: BackgroundStatus;
  score: number;
  raw: BackgroundHubResult;
}

export interface BackgroundCheckAdapter {
  readonly name: string;
  run(lead: LeadLike): Promise<BgCheckOutcome>;
}

/** Map the hub's three-way status onto a pipeline verdict. */
export function bgStatusToVerdict(status: BackgroundStatus): BgVerdict {
  switch (status) {
    case "PASS":
      return "CLEAR";
    case "FAIL":
      return "FAILED";
    // REVIEW_REQUIRED and NOT_RUN are never auto-cleared — an operator decides.
    default:
      return "REVIEW";
  }
}

const hubBackgroundCheckAdapter: BackgroundCheckAdapter = {
  name: "bg-hub",
  async run(lead: LeadLike): Promise<BgCheckOutcome> {
    const raw = await runBackgroundCheckHub(lead);
    return {
      verdict: bgStatusToVerdict(raw.final_status),
      finalStatus: raw.final_status,
      score: raw.overall_score,
      raw,
    };
  },
};

export type BgCheckProvider = "hub" | "external";

export function getBackgroundCheckProvider(): BgCheckProvider {
  const v = (process.env.BG_CHECK_PROVIDER ?? "hub").trim().toLowerCase();
  return v === "external" ? "external" : "hub";
}

/**
 * Returns the active adapter, or `null` when the provider is `external` (the
 * worker must NOT run a local check — it waits for the vendor webhook).
 */
export function getBackgroundCheckAdapter(): BackgroundCheckAdapter | null {
  return getBackgroundCheckProvider() === "external" ? null : hubBackgroundCheckAdapter;
}

// ---------------------------------------------------------------------------
// NPI adapter
// ---------------------------------------------------------------------------

/** VERIFIED auto-advances; HOLD parks the lead for manual provider confirmation. */
export type NpiVerdict = "VERIFIED" | "HOLD";

export interface NpiVerifyOutcome {
  verdict: NpiVerdict;
  status: VerifyProviderStatus;
  /** Practice-location fax from NPPES, used downstream for the HIPAA MRR fax. */
  providerFax: string | null;
  providerNpi: string | null;
  raw: VerifyProviderResult;
}

export interface NpiAdapter {
  readonly name: string;
  verify(input: VerifyProviderInput): Promise<NpiVerifyOutcome>;
}

const nppesNpiAdapter: NpiAdapter = {
  name: "nppes",
  async verify(input: VerifyProviderInput): Promise<NpiVerifyOutcome> {
    const raw = await verifyProvider(input);
    // Only a clean VERIFIED auto-advances. MISMATCH and UNAVAILABLE both go to
    // HOLD — we never treat "couldn't reach NPPES" the same as "confirmed".
    const verdict: NpiVerdict = raw.status === "VERIFIED" ? "VERIFIED" : "HOLD";
    return {
      verdict,
      status: raw.status,
      providerFax: raw.provider?.fax || null,
      providerNpi: raw.provider?.npi || null,
      raw,
    };
  },
};

export function getNpiAdapter(): NpiAdapter {
  // Single live provider today; env-selectable seam reserved for future
  // alternates (e.g. a cached/internal registry).
  return nppesNpiAdapter;
}
