import dnsPromises from "node:dns/promises";

import { auditLog } from "../audit";
import { runBackgroundCheck } from "../background-check";
import { validateAddress as validateAddressInternal } from "../address-validator";
import { validateEmail as validateEmailInternal } from "../email-validator";
import { logger } from "../logger";
import { searchPcl } from "../pacer/pcl-client";
import { searchEdgar } from "./sec-edgar";
import { searchClAttorney } from "./courtlistener-attorney";
import { checkFccRnd } from "./fcc-rnd";

import { BACKGROUND_SOURCES } from "./sources";
import { statusFromFlags } from "./escalation";
import type { BackgroundLane, BackgroundLaneResult, LeadLike } from "./types";

const CENSUS_TIMEOUT_MS = Number(process.env["CENSUS_GEOCODER_TIMEOUT_MS"] ?? 8_000);
const BOP_TIMEOUT_MS = Number(process.env["BOP_TIMEOUT_MS"] ?? 10_000);

// Adapters wrap (don't replace) existing real validators where we have them,
// and provide honest stubs for lanes where we have no live data source. Every
// adapter:
//   1. Returns a BackgroundLaneResult shaped by makeResult() (uniform).
//   2. Catches its own exceptions; the hub-level wrapper also catches as a
//      defense-in-depth. Adapters should never throw to the hub.
//   3. NEVER returns a synthetic PASS when a source is unreachable — uses
//      REVIEW_REQUIRED with a `*_not_checked` or `source_unavailable` flag.
//   4. Records the searched name + key inputs in `raw` so the operator can
//      verify the lookup matches the lead.

function makeResult(
  lane: BackgroundLane,
  flags: string[],
  raw?: unknown,
  extraNotes: string[] = [],
  error?: string,
): BackgroundLaneResult {
  const evaluated = statusFromFlags(lane, flags);
  return {
    lane,
    status: evaluated.status,
    score: evaluated.score,
    flags,
    notes: [...evaluated.notes, ...extraNotes],
    sources: [...BACKGROUND_SOURCES[lane]],
    checked_at: new Date().toISOString(),
    raw,
    error,
  };
}

function fullName(lead: LeadLike): string {
  if (lead.full_name?.trim()) return lead.full_name.trim();
  return `${lead.first_name ?? ""} ${lead.last_name ?? ""}`.trim();
}

// ---------------------------------------------------------------------------
// Address — wraps lib/address-validator (real adapter).
// Maps internal error codes (MISSING_STREET, etc.) to hub flag names.
// ---------------------------------------------------------------------------
export async function adaptAddress(lead: LeadLike): Promise<BackgroundLaneResult> {
  const inputs = {
    street_address: lead.address ?? undefined,
    city: lead.city ?? undefined,
    state: lead.state ?? undefined,
    zip: lead.zip ?? undefined,
  };
  if (!inputs.street_address && !inputs.city && !inputs.state && !inputs.zip) {
    return makeResult(
      "address",
      ["missing_address"],
      { ...inputs, reason: "no address fields on lead" },
    );
  }
  const result = validateAddressInternal(inputs);
  // Address validator codes are SCREAMING_SNAKE; our flag taxonomy is
  // lowercase. Translate.
  const flags = result.errors.map((code) => code.toLowerCase());
  return makeResult("address", flags, { ...inputs, valid: result.valid, errors: result.errors });
}

// ---------------------------------------------------------------------------
// Email — wraps lib/email-validator (real adapter, includes MX + typo + disposable).
// Adds a defensive DNS MX recheck only if the validator passed but we want to
// surface MX evidence to the operator.
// ---------------------------------------------------------------------------
export async function adaptEmail(lead: LeadLike): Promise<BackgroundLaneResult> {
  const email = (lead.email ?? "").trim();
  if (!email) {
    return makeResult("email", ["missing_email"], { email });
  }
  const result = validateEmailInternal(email);
  const flags: string[] = [];
  for (const err of result.errors) {
    // Map internal validator error strings to hub flags. Anything starting
    // with "INVALID" or "MISSING" we lowercase; anything else we map
    // explicitly so the escalation rules stay tight.
    const lower = err.toLowerCase();
    if (lower.includes("disposable")) flags.push("disposable_domain");
    else if (lower.includes("mx")) flags.push("no_mx_records");
    else if (lower.includes("format") || lower.includes("invalid")) flags.push("invalid_email_format");
    else if (lower.includes("missing")) flags.push("missing_email");
    else flags.push(lower.replace(/[^a-z0-9_]/g, "_"));
  }
  // Surface a typo correction as REVIEW (not FAIL) — operator confirms.
  if (result.suggestion) {
    flags.push("typo_suggestion");
  }
  // Role-based heuristic on top of the validator (operator-facing).
  if (/^(admin|info|support|sales|contact|noreply|no-reply)@/i.test(email)) {
    flags.push("role_based_email");
  }
  // Never claim SMTP was checked — we don't do mailbox probing.
  flags.push("smtp_not_checked");

  // Best-effort MX evidence for raw{} (does not change status; the validator
  // already authoritatively flagged if MX is missing).
  let mxEvidence: string[] | null = null;
  if (result.valid) {
    const domain = email.split("@")[1];
    if (domain) {
      try {
        const records = await dnsPromises.resolveMx(domain);
        mxEvidence = records.map((r) => `${r.priority} ${r.exchange}`);
      } catch (err) {
        logger.debug({ err, domain }, "bg-hub: MX evidence lookup failed (non-blocking)");
      }
    }
  }
  return makeResult(
    "email",
    flags,
    {
      email,
      valid: result.valid,
      validator_errors: result.errors,
      suggestion: result.suggestion ?? null,
      mx: mxEvidence,
    },
  );
}

// ---------------------------------------------------------------------------
// Phone — E.164 format validation + FCC Reassigned Numbers Database check.
//
// The FCC RND check is vault-gated (free key from rnd.fcc.gov):
//   - No key configured   → phone_not_checked  (REVIEW — same as before)
//   - Clean (not reassigned) → no adverse flag (PASS for format-valid number)
//   - Reassigned           → fcc_rnd_reassigned (REVIEW — TCPA risk)
//   - Not in RND dataset   → fcc_rnd_not_in_rnd (REVIEW — non-US/VoIP)
//   - API unavailable      → fcc_rnd_unavailable + phone_not_checked (REVIEW)
//
// Configuring the FCC RND key is the path to getting PASS on the phone lane.
// Without it the lane stays REVIEW_REQUIRED — never a silent PASS.
// ---------------------------------------------------------------------------
export async function adaptPhone(lead: LeadLike): Promise<BackgroundLaneResult> {
  const raw = (lead.phone ?? "").trim();
  const digits = raw.replace(/\D/g, "");

  if (!digits) {
    return makeResult("phone", ["missing_phone"], { input: raw, normalized: "" });
  }
  if (digits.length !== 10 && digits.length !== 11) {
    return makeResult("phone", ["invalid_phone_format"], { input: raw, normalized: digits });
  }

  // Normalize: strip leading country code if present.
  const normalized = digits.length === 11 && digits.startsWith("1") ? digits.slice(1) : digits;

  // Attempt FCC RND check — vault-gated, degrades gracefully when unconfigured.
  try {
    const fcc = await checkFccRnd(normalized);

    switch (fcc.status) {
      case "unconfigured":
        // No key — same honest stub behavior as before.
        return makeResult(
          "phone",
          ["phone_not_checked"],
          {
            input: raw,
            normalized,
            fcc_rnd: "not_configured — add FCC_RND_API_KEY to vault for TCPA reassignment check (free: rnd.fcc.gov)",
          },
        );

      case "clean":
        // FCC confirms number not reassigned within lookback — no adverse flag.
        return makeResult(
          "phone",
          [],
          {
            input: raw,
            normalized,
            fcc_rnd: {
              status: "clean",
              call_date: fcc.call_date,
              checked_at: fcc.checked_at,
              note: "Number not reassigned within FCC RND lookback period.",
            },
          },
        );

      case "reassigned":
        return makeResult(
          "phone",
          ["fcc_rnd_reassigned"],
          {
            input: raw,
            normalized,
            fcc_rnd: {
              status: "reassigned",
              call_date: fcc.call_date,
              last_assigned_date: fcc.last_assigned_date,
              checked_at: fcc.checked_at,
              note: "TCPA risk: number was reassigned after the consent lookback date. Operator must re-verify consent with current subscriber.",
            },
          },
          [
            `FCC RND: phone number ${normalized} was reassigned after ${fcc.call_date}. TCPA risk — operator must re-verify consent.`,
          ],
        );

      case "invalid":
        return makeResult(
          "phone",
          ["fcc_rnd_not_in_rnd"],
          {
            input: raw,
            normalized,
            fcc_rnd: { status: "not_in_rnd", note: fcc.note },
          },
          [`FCC RND: ${fcc.note}`],
        );

      case "unavailable":
        return makeResult(
          "phone",
          ["fcc_rnd_unavailable", "phone_not_checked"],
          {
            input: raw,
            normalized,
            fcc_rnd: { status: "unavailable", note: fcc.note },
          },
          [`FCC RND unavailable: ${fcc.note}. TCPA reassignment check skipped.`],
        );
    }
  } catch (err) {
    logger.warn({ err }, "bg-hub: adaptPhone FCC check threw unexpectedly");
    return makeResult(
      "phone",
      ["fcc_rnd_unavailable", "phone_not_checked"],
      { input: raw, normalized },
    );
  }
}

// ---------------------------------------------------------------------------
// Residency — US Census Geocoder (free, no API key) confirms the address
// exists in the Census TIGER/Line dataset. Not proof of residency — county
// property/tax-assessor records still required for final confirmation — but
// removes the "we didn't even look" problem and catches completely fabricated
// addresses. Falls back to the honest stub when the Geocoder is unreachable.
// ---------------------------------------------------------------------------
export async function adaptResidency(lead: LeadLike): Promise<BackgroundLaneResult> {
  const { address, city, state, zip } = lead;

  if (!address && !city && !state) {
    return makeResult(
      "residency",
      ["residency_not_checked"],
      { address, city, state, zip },
      ["Address incomplete — residency cannot be checked."],
    );
  }

  const parts = [address, city, state && zip ? `${state} ${zip}` : (state ?? zip)].filter(Boolean);
  const fullAddress = parts.join(", ");

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), CENSUS_TIMEOUT_MS);
  try {
    const url =
      `https://geocoding.geo.census.gov/geocoder/locations/onelineaddress` +
      `?address=${encodeURIComponent(fullAddress)}&benchmark=2020&format=json`;
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { "User-Agent": "mass-tort-os/bg-hub-residency", Accept: "application/json" },
    });
    clearTimeout(timer);

    if (!res.ok) {
      return makeResult(
        "residency",
        ["geocode_unavailable"],
        { address: fullAddress },
        [`Census Geocoder returned HTTP ${res.status}. Operator: verify address manually.`],
      );
    }

    const data = (await res.json()) as {
      result?: { addressMatches?: Array<{ matchedAddress?: string; coordinates?: { x?: number; y?: number } }> };
    };
    const matches = data.result?.addressMatches ?? [];

    if (matches.length === 0) {
      return makeResult(
        "residency",
        ["geocode_no_match"],
        { searched_address: fullAddress },
        [
          "Census Geocoder found no match for this address. May be a new development, PO box, or fabricated address. Operator: verify via county property/tax-assessor records.",
        ],
      );
    }

    const top = matches[0]!;
    return makeResult(
      "residency",
      ["geocode_match"],
      {
        searched_address: fullAddress,
        matched_address: top.matchedAddress,
        coordinates: top.coordinates,
        match_count: matches.length,
      },
      [
        `Address geocoded: ${top.matchedAddress ?? ""}. Coordinates: (${top.coordinates?.x ?? "?"}, ${top.coordinates?.y ?? "?"}). Operator: confirm residency via county property/tax-assessor records.`,
      ],
    );
  } catch (err) {
    clearTimeout(timer);
    if ((err as { name?: string }).name === "AbortError") {
      return makeResult(
        "residency",
        ["geocode_unavailable"],
        { address: fullAddress },
        [`Census Geocoder timed out after ${CENSUS_TIMEOUT_MS}ms. Operator: verify address manually.`],
      );
    }
    logger.warn({ err }, "bg-hub: Census Geocoder failed");
    return makeResult(
      "residency",
      ["geocode_unavailable"],
      { address: fullAddress },
      [`Census Geocoder unavailable: ${err instanceof Error ? err.message : String(err)}`],
    );
  }
}

// ---------------------------------------------------------------------------
// Criminal court — wraps lib/background-check.ts (CourtListener live adapter).
// We translate its {status, records, notes} into hub flags. OFAC/sanctions
// records returned by background-check.ts are surfaced as well so the operator
// sees them once, in this lane (sex_offender_nsopw remains a separate honest
// stub for NSOPW specifically — OFAC is sanctions, not sex-offender).
// ---------------------------------------------------------------------------
export async function adaptCriminalCourt(lead: LeadLike): Promise<BackgroundLaneResult> {
  if (!lead.first_name || !lead.last_name) {
    return makeResult(
      "criminal_court",
      ["court_check_not_run"],
      { reason: "lead missing first_name or last_name" },
      ["Cannot run court check without first/last name."],
    );
  }
  try {
    const bg = await runBackgroundCheck({
      first_name: lead.first_name,
      last_name: lead.last_name,
      state: lead.state ?? undefined,
      date_of_birth: lead.dob ?? undefined,
    });
    const flags: string[] = [];
    if (bg.status === "error") {
      flags.push("court_source_unreachable");
    } else if (bg.status === "flagged" && bg.records.length > 0) {
      // Don't auto-FAIL — surface as REVIEW for human eyes. The hub avoids
      // claiming a hard criminal match unless the operator confirms identity.
      flags.push("court_records_found_review");
    }
    // OFAC honesty check: runBackgroundCheck() can return status: "clean"
    // even when OFAC was never actually queried (key missing) or unreachable
    // (provider HTTP error). It records the issue in `bg.notes` rather than
    // mutating the headline status. We must inspect the notes and escalate
    // to REVIEW so a partially-checked lead never silently PASSes through
    // the criminal_court lane just because the court half came back clean.
    const ofacSkipped = (bg.notes ?? []).some((n) =>
      /ofac.*(skipped|unavailable|unconfigured|not\s+configured|provider)/i.test(n),
    );
    if (ofacSkipped) {
      flags.push("ofac_unavailable");
    }
    // Same defense for the courts side: if the source-notes call out the
    // CourtListener fetch failed but bg.status didn't propagate "error",
    // escalate.
    const courtUnreachable = (bg.notes ?? []).some((n) =>
      /court records source.*unreachable|courtlistener.*unreachable/i.test(n),
    );
    if (courtUnreachable && !flags.includes("court_source_unreachable")) {
      flags.push("court_source_unreachable");
    }
    // bg.status of "clean" or "not_found" with no source-notes → no flags → PASS.
    return makeResult(
      "criminal_court",
      flags,
      {
        searched_name: fullName(lead),
        searched_state: bg.searched_state,
        searched_state_label: bg.searched_state_label,
        search_scope: bg.search_scope,
        searched_courts: bg.searched_courts,
        records: bg.records,
        summary: bg.summary,
        source_notes: bg.notes,
      },
    );
  } catch (err) {
    return makeResult(
      "criminal_court",
      ["court_source_unreachable"],
      { searched_name: fullName(lead) },
      ["Adapter raised an exception — see error field."],
      err instanceof Error ? err.message : String(err),
    );
  }
}

// ---------------------------------------------------------------------------
// Incarceration — Federal BOP JSON API (live, free, no key needed).
// Searches the Federal Bureau of Prisons inmate locator for the lead's name.
// Scope is federal only — state DOC and county jails are not checked.
// BOP returns CAPTCHA challenges under bot-detection; when that triggers the
// adapter returns REVIEW_REQUIRED rather than a false PASS.
// ---------------------------------------------------------------------------
export async function adaptIncarceration(lead: LeadLike): Promise<BackgroundLaneResult> {
  const firstName = (lead.first_name ?? "").trim();
  const lastName = (lead.last_name ?? "").trim();
  const searched = fullName(lead);

  if (!firstName || !lastName) {
    return makeResult(
      "incarceration",
      ["incarceration_check_not_run"],
      { searched_name: searched, reason: "lead missing first_name or last_name" },
      ["Cannot run BOP check without first/last name."],
    );
  }

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), BOP_TIMEOUT_MS);
  try {
    const params = new URLSearchParams({
      todo: "query",
      output: "json",
      nameFirst: firstName,
      nameLast: lastName,
      Middle: "",
      Race: "U",
      Sex: "U",
      Age: "",
    });
    const url = `https://www.bop.gov/PublicInfo/execute/inmateloc?${params.toString()}`;
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { "User-Agent": "mass-tort-os/bg-hub-incarceration", Accept: "application/json" },
    });
    clearTimeout(timer);

    if (!res.ok) {
      return makeResult(
        "incarceration",
        ["bop_source_unavailable"],
        { searched_name: searched },
        [`BOP HTTP ${res.status}. Operator: check https://www.bop.gov/inmateloc/ manually.`],
      );
    }

    const data = (await res.json()) as {
      Captcha?: boolean | string;
      InmateLocator?: Array<{
        inmateNum?: string;
        nameFirst?: string;
        nameLast?: string;
        nameMiddle?: string;
        sex?: string;
        race?: string;
        age?: number;
        releaseDate?: string;
        releaseDateType?: string;
        facilityCode?: string;
        facilityName?: string;
      }>;
    };

    // BOP can return a CAPTCHA challenge under bot-detection. When triggered,
    // never claim the lead is clean — surface as REVIEW_REQUIRED.
    if (data.Captcha === true || data.Captcha === "true" || data.Captcha === "1") {
      return makeResult(
        "incarceration",
        ["bop_captcha_required"],
        { searched_name: searched },
        [
          "BOP inmate locator returned a CAPTCHA challenge — automated search blocked. Operator: check https://www.bop.gov/inmateloc/ manually.",
        ],
      );
    }

    const inmates = data.InmateLocator ?? [];

    if (inmates.length === 0) {
      return makeResult(
        "incarceration",
        ["bop_no_records_found"],
        {
          searched_name: searched,
          searched_first: firstName,
          searched_last: lastName,
          scope: "Federal BOP only (state DOC / county jails not checked)",
        },
        [
          "No BOP federal inmate records found. Note: BOP covers federal facilities only — state prisons and county jails are not included.",
        ],
      );
    }

    // Hits found — REVIEW_REQUIRED: operator must confirm identity via inmate
    // number before treating as a match.
    return makeResult(
      "incarceration",
      ["bop_records_found_review"],
      {
        searched_name: searched,
        record_count: inmates.length,
        records: inmates.slice(0, 5).map((i) => ({
          inmate_number: i.inmateNum,
          name: `${i.nameFirst ?? ""} ${i.nameLast ?? ""}`.trim(),
          age: i.age,
          sex: i.sex,
          race: i.race,
          facility: i.facilityName ?? i.facilityCode,
          release_date: i.releaseDate,
          release_date_type: i.releaseDateType,
        })),
        scope: "Federal BOP only",
      },
      [
        `BOP found ${inmates.length} record(s) matching this name. Operator: confirm identity via inmate number before treating as a match. BOP covers federal facilities only.`,
      ],
    );
  } catch (err) {
    clearTimeout(timer);
    if ((err as { name?: string }).name === "AbortError") {
      return makeResult(
        "incarceration",
        ["bop_source_unavailable"],
        { searched_name: searched },
        [`BOP inmate locator timed out after ${BOP_TIMEOUT_MS}ms. Operator: check https://www.bop.gov/inmateloc/ manually.`],
      );
    }
    logger.warn({ err }, "bg-hub: BOP inmate locator fetch failed");
    return makeResult(
      "incarceration",
      ["bop_source_unavailable"],
      { searched_name: searched },
      [`BOP unavailable: ${err instanceof Error ? err.message : String(err)}`],
    );
  }
}

// ---------------------------------------------------------------------------
// Sex offender (NSOPW) — honest stub. NSOPW prohibits automated scraping.
// ---------------------------------------------------------------------------
export async function adaptNSOPW(lead: LeadLike): Promise<BackgroundLaneResult> {
  return makeResult(
    "sex_offender_nsopw",
    ["nsopw_manual_check_required"],
    {
      searched_name: fullName(lead),
      searched_state: lead.state,
      searched_zip: lead.zip,
      source: "https://www.nsopw.gov/",
      automation_policy:
        "No fake PASS. Manual NSOPW lookup required — automated scraping is prohibited by NSOPW terms of use.",
    },
    ["Open NSOPW manually and record the result before clearing this lane."],
  );
}

// ---------------------------------------------------------------------------
// Attorney — CourtListener RECAP search (live, free, no API key needed).
//
// Searches the public CourtListener RECAP index for the lead's name appearing
// in the attorney-of-record field. If a claimant is a licensed attorney who
// has appeared as counsel in federal cases, the operator must review for
// conflict-of-interest or intelligence-gathering risk.
//
// Coverage: federal courts only (via PACER/RECAP). State bar membership is
// NOT checked — smart links to state bar lookups are always included.
// Vault-stored courtlistener token unlocks the /attorneys/ endpoint for
// higher-fidelity name matching and better rate limits.
// ---------------------------------------------------------------------------
export async function adaptAttorney(lead: LeadLike): Promise<BackgroundLaneResult> {
  const firstName = (lead.first_name ?? "").trim();
  const lastName = (lead.last_name ?? "").trim();

  if (!firstName || !lastName) {
    return makeResult(
      "attorney",
      ["attorney_not_checked"],
      {
        searched_name: fullName(lead),
        reason: "lead missing first_name or last_name",
      },
      ["Cannot run attorney check without first/last name."],
    );
  }

  try {
    const result = await searchClAttorney(firstName, lastName);

    if (result.status === "source_unavailable") {
      return makeResult(
        "attorney",
        ["attorney_check_source_unavailable"],
        { searched_name: fullName(lead) },
        [
          `CourtListener unavailable: ${result.note}. Operator: check state bar manually.`,
        ],
      );
    }

    if (result.status === "not_found") {
      return makeResult(
        "attorney",
        ["attorney_search_ran_no_hits"],
        {
          searched_name: result.search_name,
          checked_at: result.checked_at,
          scope: "CourtListener federal RECAP index (state bar NOT checked)",
        },
        [
          "CourtListener found no federal attorney-of-record appearances for this name. State bar membership is not checked — use the smart link to verify if needed.",
        ],
      );
    }

    // result.status === "ok" — hits found
    return makeResult(
      "attorney",
      ["possible_attorney_hit"],
      {
        searched_name: result.search_name,
        checked_at: result.checked_at,
        case_count: result.hits.length,
        cases: result.hits.map((h) => ({
          case_name: h.case_name,
          docket_number: h.docket_number,
          court: h.court,
          date_filed: h.date_filed,
          attorney_name: h.attorney_name,
          firm: h.firm,
          docket_url: h.docket_url,
        })),
        scope: "CourtListener federal RECAP index",
      },
      [
        `CourtListener found ${result.hits.length} case(s) where this name appears as attorney of record. Operator: confirm whether this claimant is a licensed attorney and assess conflict-of-interest risk.`,
      ],
    );
  } catch (err) {
    logger.warn({ err }, "bg-hub: adaptAttorney caught unexpected error");
    return makeResult(
      "attorney",
      ["attorney_check_source_unavailable"],
      { searched_name: fullName(lead) },
      ["Attorney check failed unexpectedly — see error field."],
      err instanceof Error ? err.message : String(err),
    );
  }
}

// ---------------------------------------------------------------------------
// PACER federal courts — live adapter via PCL Search API.
// Vault-only credentials (provider="pacer"). PACER is opt-in (per-page
// billing) so any path where we did NOT actually search returns NOT_RUN
// with a clear reason flag — never a silent PASS, never a noisy REVIEW for
// a service failure. The states are:
//
//   no name on lead       → NOT_RUN (no flags)
//   integration missing   → NOT_RUN ("pacer_not_configured")
//   auth rejected         → NOT_RUN ("pacer_auth_failed") + error
//   network/HTTP failure  → NOT_RUN ("pacer_source_unreachable") + error
//   search succeeded:
//     0 hits              → PASS  (statusFromFlags with no flags)
//     ≥1 hit              → REVIEW_REQUIRED ("pacer_records_found_review",
//                            optionally "pacer_active_criminal_docket")
//
// Hits never auto-FAIL — PCL returns party names without identity-
// confirming metadata. The operator promotes a hit to FAIL after manually
// reviewing the docket via the docketUrl included on each case.
// Every outcome is audit-logged so operators can always answer "did we
// run PACER on this lead, and what happened?"
// ---------------------------------------------------------------------------
function buildPacerNotRun(
  lead: LeadLike,
  flag: string,
  notes: string[],
  rawExtra: Record<string, unknown> = {},
  error?: string,
): BackgroundLaneResult {
  return {
    lane: "pacer_federal",
    status: "NOT_RUN",
    score: 0,
    flags: [flag],
    notes,
    sources: [...BACKGROUND_SOURCES.pacer_federal],
    checked_at: new Date().toISOString(),
    raw: { searched_name: fullName(lead), ...rawExtra },
    ...(error ? { error } : {}),
  };
}

async function logPacerRun(
  lead: LeadLike,
  outcome: "success" | "not_configured" | "auth_failed" | "source_unreachable" | "skipped_missing_name",
  details: Record<string, unknown> = {},
) {
  try {
    await auditLog("lead", String(lead.id ?? "unknown"), "pacer_run", {
      outcome,
      ...details,
    });
  } catch (err) {
    // auditLog already swallows its own errors, but be paranoid: this
    // adapter MUST NOT throw from the audit path.
    logger.error({ err }, "PACER adapter: audit log write failed");
  }
}

export async function adaptPacer(lead: LeadLike): Promise<BackgroundLaneResult> {
  if (!lead.first_name || !lead.last_name) {
    void logPacerRun(lead, "skipped_missing_name");
    return {
      lane: "pacer_federal",
      status: "NOT_RUN",
      score: 0,
      flags: [],
      notes: ["PACER lookup skipped — lead missing first_name or last_name."],
      sources: [...BACKGROUND_SOURCES.pacer_federal],
      checked_at: new Date().toISOString(),
      raw: { searched_name: fullName(lead) },
    };
  }

  try {
    const outcome = await searchPcl({
      firstName: lead.first_name,
      lastName: lead.last_name,
      dateOfBirth: lead.dob ?? null,
    });

    if (outcome.ok === false && outcome.reason === "NOT_CONFIGURED") {
      void logPacerRun(lead, "not_configured");
      return buildPacerNotRun(
        lead,
        "pacer_not_configured",
        [
          "PACER lane skipped — no active 'pacer' integration in the vault. Add credentials in Settings → Integrations to enable federal court searches (per-page billing applies).",
        ],
        { configured: false },
      );
    }

    if (outcome.ok === false && outcome.reason === "AUTH_FAILED") {
      void logPacerRun(lead, "auth_failed", { message: outcome.message });
      return buildPacerNotRun(
        lead,
        "pacer_auth_failed",
        [
          "PACER credentials were rejected by the auth endpoint. Re-check the username/password in Settings → Integrations. Lane was NOT run.",
        ],
        { reason: "AUTH_FAILED" },
        outcome.message,
      );
    }

    if (outcome.ok === false) {
      // SOURCE_UNREACHABLE.
      void logPacerRun(lead, "source_unreachable", { message: outcome.message });
      return buildPacerNotRun(
        lead,
        "pacer_source_unreachable",
        [
          "PACER service was unreachable (network or HTTP error). Lane was NOT run; retry later. Operator must not interpret this as a clean record.",
        ],
        { reason: "SOURCE_UNREACHABLE" },
        outcome.message,
      );
    }

    const flags: string[] = [];
    if (outcome.cases.length > 0) {
      flags.push("pacer_records_found_review");
      // If any returned case is a criminal docket (court_type=cr / nature
      // codes that begin with "Criminal"), surface that as a separate flag
      // so the operator notices it without auto-FAILing.
      const hasCriminal = outcome.cases.some((c) => {
        const cn = (c.caseNumberFull ?? "").toLowerCase();
        const courtType = (c.courtType ?? "").toLowerCase();
        const nature = (c.natureOfSuit ?? "").toLowerCase();
        return (
          cn.includes("-cr-") ||
          courtType.includes("criminal") ||
          nature.includes("criminal")
        );
      });
      if (hasCriminal) flags.push("pacer_active_criminal_docket");
    }

    void logPacerRun(lead, "success", {
      case_count: outcome.cases.length,
      truncated: outcome.truncated,
      criminal_hit: flags.includes("pacer_active_criminal_docket"),
    });

    return makeResult(
      "pacer_federal",
      flags,
      {
        searched_name: fullName(lead),
        searched_dob: lead.dob ?? null,
        case_count: outcome.cases.length,
        truncated: outcome.truncated,
        cases: outcome.cases.slice(0, 10).map((c) => ({
          case_number: c.caseNumberFull,
          title: c.caseTitle,
          year: c.caseYear,
          court_id: c.courtId,
          court_type: c.courtType,
          date_filed: c.dateFiled,
          nature_of_suit: c.natureOfSuit,
          docket_url: c.docketUrl,
        })),
      },
      outcome.cases.length === 0
        ? ["No PACER cases found for this name."]
        : [`Operator: confirm identity by purchasing the docket(s) before treating as a match.`],
    );
  } catch (err) {
    // Defense-in-depth — searchPcl already returns outcome objects rather
    // than throwing, but a programming error here must never bubble up
    // and break the parallel adapter fan-out. Treat as SOURCE_UNREACHABLE
    // (NOT_RUN) per the same honesty principle: if we didn't actually
    // talk to PACER, do not pretend the lead is clean.
    const message = err instanceof Error ? err.message : String(err);
    void logPacerRun(lead, "source_unreachable", { message, programming_error: true });
    return buildPacerNotRun(
      lead,
      "pacer_source_unreachable",
      ["PACER adapter raised an exception — see error field. Lane was NOT run."],
      { reason: "ADAPTER_EXCEPTION" },
      message,
    );
  }
}

// ---------------------------------------------------------------------------
// Business entity — SEC EDGAR live search + SoS smart links.
//
// SEC EDGAR (data.sec.gov) is free, no API key, covers ~10 K publicly-traded
// and SEC-registered entities. Small private LLCs are NOT in EDGAR — for
// those the operator uses the Secretary-of-State smart link baked into the
// hub card. EDGAR is cached in-process (refreshed every 24 h) so the lookup
// is near-instant after the first server boot.
//
// Skipped entirely (NOT_RUN) when the lead has no business name.
// ---------------------------------------------------------------------------
export async function adaptBusiness(lead: LeadLike): Promise<BackgroundLaneResult> {
  const bizName = lead.business_name?.trim() ?? "";

  if (!bizName) {
    return {
      lane: "business_entity",
      status: "NOT_RUN",
      score: 0,
      flags: [],
      notes: ["No business name on lead — business-entity check skipped."],
      sources: [...BACKGROUND_SOURCES.business_entity],
      checked_at: new Date().toISOString(),
      raw: { business_name: null },
    };
  }

  try {
    const edgar = await searchEdgar(bizName);

    if (edgar.status === "error") {
      return makeResult(
        "business_entity",
        ["sec_edgar_unavailable"],
        { business_name: bizName, edgar_note: edgar.note },
        [
          `SEC EDGAR unavailable: ${edgar.note ?? "unknown error"}. Operator: verify via Secretary of State directory.`,
        ],
      );
    }

    if (edgar.matches.length === 0) {
      return makeResult(
        "business_entity",
        ["entity_not_found_sec_edgar"],
        {
          business_name: bizName,
          edgar_fetched_at: edgar.fetched_at,
          note: "Not found in SEC EDGAR — likely a private LLC or sole proprietor.",
        },
        [
          "Entity not found in SEC EDGAR (10 K+ public/SEC-registered companies). This is normal for private LLCs and sole proprietors. Operator: verify via Secretary of State directory.",
        ],
      );
    }

    return makeResult(
      "business_entity",
      ["sec_edgar_found"],
      {
        business_name: bizName,
        edgar_fetched_at: edgar.fetched_at,
        match_count: edgar.matches.length,
        matches: edgar.matches.map((m) => ({
          cik: m.cik,
          ticker: m.ticker,
          title: m.title,
          edgar_url: m.edgar_url,
        })),
      },
      [
        `Found ${edgar.matches.length} SEC EDGAR match(es) for "${bizName}". Operator: confirm this is the correct entity and review recent filings on the EDGAR page.`,
      ],
    );
  } catch (err) {
    logger.warn({ err }, "bg-hub: SEC EDGAR adaptBusiness error");
    return makeResult(
      "business_entity",
      ["sec_edgar_unavailable"],
      { business_name: bizName },
      ["SEC EDGAR check failed unexpectedly — see error field."],
      err instanceof Error ? err.message : String(err),
    );
  }
}
