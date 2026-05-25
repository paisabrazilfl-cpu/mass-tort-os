// Background Check Hub — unified vocabulary across every claimant-verification
// lane the operator can run. Status semantics:
//
//   PASS            — adapter ran and returned no adverse signals
//   REVIEW_REQUIRED — adapter ran but result needs human eyes (or adapter is
//                     deliberately a stub because no live data source is wired)
//   FAIL            — adapter ran and returned a hard adverse signal
//   NOT_RUN         — preconditions for the adapter were not met (e.g. lane
//                     skipped because the lead has no business name)
//
// The Hub never invents a PASS when a source is unreachable. Honest review
// states are mandatory — see escalation.ts and the README in the same folder.

export type BackgroundStatus = "PASS" | "REVIEW_REQUIRED" | "FAIL" | "NOT_RUN";

export type BackgroundLane =
  | "address"
  | "email"
  | "phone"
  | "phone_provenance"
  | "residency"
  | "criminal_court"
  | "incarceration"
  | "sex_offender_nsopw"
  | "attorney"
  | "business_entity"
  | "pacer_federal";

export type BackgroundSourceType =
  | "primary"
  | "federal"
  | "state"
  | "county"
  | "technical"
  | "directory"
  | "secondary";

export interface BackgroundSource {
  name: string;
  url: string;
  source_type: BackgroundSourceType;
  requires_api_key: boolean;
  live_adapter_available: boolean;
  notes?: string;
}

export interface BackgroundLaneResult {
  lane: BackgroundLane;
  status: BackgroundStatus;
  score: number;
  flags: string[];
  notes: string[];
  sources: BackgroundSource[];
  checked_at: string;
  raw?: unknown;
  error?: string;
}

export interface BackgroundHubResult {
  lead_id: number;
  version: string;
  final_status: BackgroundStatus;
  overall_score: number;
  checked_at: string;
  summary: {
    pass: number;
    review_required: number;
    fail: number;
    not_run: number;
  };
  results: BackgroundLaneResult[];
}

// What the Hub needs from a lead row. Mapped from leads table columns by the
// route layer (street_address → address, date_of_birth → dob, etc.) so the
// hub library is decoupled from the DB schema shape.
export interface LeadLike {
  id: number;
  first_name?: string | null;
  last_name?: string | null;
  full_name?: string | null;
  email?: string | null;
  phone?: string | null;
  address?: string | null;
  city?: string | null;
  state?: string | null;
  zip?: string | null;
  dob?: string | null;
  business_name?: string | null;
}

export const BG_HUB_VERSION = "background-check-hub-v1";
