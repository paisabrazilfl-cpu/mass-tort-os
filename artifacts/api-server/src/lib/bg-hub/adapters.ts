import dnsPromises from "node:dns/promises";

import { auditLog } from "../audit";
import { runBackgroundCheck } from "../background-check";
import { validateAddress as validateAddressInternal } from "../address-validator";
import { validateEmail as validateEmailInternal } from "../email-validator";
import { logger } from "../logger";
import { searchPcl } from "../pacer/pcl-client";

import { BACKGROUND_SOURCES } from "./sources";
import { statusFromFlags } from "./escalation";
import { searchEdgar } from "./sec-edgar";
import { _runGarboCheckWithOverride, isGarboConfigured } from "./garbo";
import { _lookupPhoneProvenanceWithOverride } from "./phone-provenance";
import { enrichEmail } from "./email-enrichment";
import {
  bopInmateSearchUrl,
  nsopwSearchUrl,
  propertyRecordsSearchUrl,
  stateBarSearchUrl,
  stateSosSearchUrl,
  vineLinkSearchUrl,
} from "./smart-links";
import type { BackgroundLane, BackgroundLaneResult, LeadLike } from "./types";

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
  manualActionUrls?: BackgroundLaneResult["manual_action_urls"],
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
    manual_action_urls: manualActionUrls,
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
  // Email enrichment — disposable / role / free-provider signals from
  // lib/bg-hub/email-enrichment.ts. The existing validator already
  // emits some of these via its internal regex; we merge the canonical
  // flag set here so the curated disposable-domain list (40+ entries)
  // is the source of truth instead of the validator's smaller list.
  const enrichment = enrichEmail(email);
  for (const f of enrichment.flags) {
    if (!flags.includes(f)) flags.push(f);
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
// Phone — format-only check. Twilio Lookup adapter is NOT wired.
// ---------------------------------------------------------------------------
export async function adaptPhone(lead: LeadLike): Promise<BackgroundLaneResult> {
  const raw = (lead.phone ?? "").trim();
  const digits = raw.replace(/\D/g, "");
  const flags: string[] = [];
  if (!digits) {
    flags.push("missing_phone");
  } else if (digits.length !== 10 && digits.length !== 11) {
    flags.push("invalid_phone_format");
  } else {
    // Format is plausible but we have no carrier-level signal.
    flags.push("phone_not_checked");
  }
  return makeResult("phone", flags, { input: raw, normalized: digits });
}

// ---------------------------------------------------------------------------
// Residency — honest stub for automation, but emits a prefilled smart-link
// to the local county property-records / appraiser portal so the operator
// can run the lookup in one click. NCOA / county-records-aggregator
// automation requires a paid integration (Smarty, ATTOM, LexisNexis Risk)
// that we don't ship — the smart-link path is the free, ethical fallback.
// ---------------------------------------------------------------------------
export async function adaptResidency(lead: LeadLike): Promise<BackgroundLaneResult> {
  const haveAddress = Boolean(lead.address && lead.city && lead.state);
  const flags = haveAddress ? ["no_residency_corroboration"] : ["residency_not_checked"];
  const propertyUrl = propertyRecordsSearchUrl(lead);
  const manualUrls = propertyUrl
    ? [{
        label: `Search ${lead.city ?? "local"} property records`,
        url: propertyUrl,
        note: "Verify the lead is listed on a current property/tax assessment for this address.",
      }]
    : undefined;
  return makeResult(
    "residency",
    flags,
    {
      address: lead.address,
      city: lead.city,
      state: lead.state,
      zip: lead.zip,
    },
    haveAddress
      ? ["Operator: confirm via county property/tax assessor lookup."]
      : ["Address incomplete — residency cannot be checked."],
    undefined,
    manualUrls,
  );
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
    // even when OFAC was never actually queried or unreachable. It records
    // the issue in `bg.notes` rather than mutating the headline status. We
    // split that into two outcomes:
    //
    //   ofac_unconfigured — operator deliberately disabled Treasury and
    //                       didn't supply an OFAC_API_KEY. Pre-flight
    //                       signal, routes to NOT_RUN via the `skip`
    //                       category in escalation.ts.
    //   ofac_unavailable  — we tried and got nothing back (5xx, network
    //                       error, malformed response). Routes to REVIEW.
    //
    // With the free Treasury SDN path enabled (default), the unconfigured
    // branch is essentially unreachable. We keep emitting it so an
    // operator who deliberately disables Treasury sees an honest NOT_RUN
    // signal instead of a misleading REVIEW.
    const ofacNotes = (bg.notes ?? []).filter((n) => /ofac/i.test(n));
    const ofacUnconfigured = ofacNotes.some((n) =>
      /skipped.*no\s+provider|unconfigured|not\s+configured/i.test(n),
    );
    const ofacUnreachable = ofacNotes.some(
      (n) => !/skipped.*no\s+provider|unconfigured|not\s+configured/i.test(n)
        && /unavailable|provider returned|http \d|timeout|unreachable/i.test(n),
    );
    if (ofacUnreachable) {
      flags.push("ofac_unavailable");
    } else if (ofacUnconfigured) {
      flags.push("ofac_unconfigured");
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
// Incarceration — stub for live data (Federal BOP has no stable JSON API
// and most state DOCs are web-only). We emit smart-links to BOP's public
// inmate locator and VINELink (which covers ~46 states) so the operator
// can run the lookup in two clicks instead of typing the name into five
// websites. Full automation requires a paid VINELink partner API key.
// ---------------------------------------------------------------------------
export async function adaptIncarceration(lead: LeadLike): Promise<BackgroundLaneResult> {
  const manualUrls: BackgroundLaneResult["manual_action_urls"] = [
    {
      label: "Search Federal BOP Inmate Locator",
      url: bopInmateSearchUrl(lead),
      note: "Confirms federal-prison custody status. BOP terms of use forbid automated queries; click to run manually.",
    },
  ];
  const vine = vineLinkSearchUrl(lead);
  if (vine) {
    manualUrls.push({
      label: lead.state ? `VINELink (${lead.state} state DOC)` : "VINELink (all-state inmate locator)",
      url: vine,
      note: "State + county custody lookup. Covers ~46 states.",
    });
  }
  return makeResult(
    "incarceration",
    ["incarceration_check_not_run"],
    {
      searched_name: fullName(lead),
      manual_sources: ["Federal BOP Inmate Locator", "VINELink (state DOC)", "County jail lookup"],
    },
    ["Operator: click a smart-link below to run the lookup. Full automation requires a paid VINELink partner API."],
    undefined,
    manualUrls,
  );
}

// ---------------------------------------------------------------------------
// Sex offender (NSOPW + Garbo) — hybrid lane.
//
// Direct NSOPW scraping is forbidden by their TOS, but Garbo (an
// FCRA-compliant API-first provider) aggregates the sex-offender
// registry data from compliant sources we can lawfully consume.
// When the operator has wired up a Garbo integration we run the live
// check; otherwise we fall back to the NSOPW prefilled smart-link the
// operator clicks manually.
//
// Garbo signal mapping:
//   hit with is_sex_offender_registry=true → flag "garbo_sex_offender_hit" → FAIL
//   error / network failure                → flag "garbo_unreachable"     → REVIEW
//   ok with empty hits                     → no flags                     → PASS
//                                            (NSOPW smart-link still surfaced
//                                            as a manual-confirm option)
// ---------------------------------------------------------------------------
export async function adaptNSOPW(lead: LeadLike): Promise<BackgroundLaneResult> {
  const manualUrls: BackgroundLaneResult["manual_action_urls"] = [
    {
      label: "Search NSOPW (National Sex Offender Public Website)",
      url: nsopwSearchUrl(lead),
      note: "Manual fallback — click to run the lookup yourself. Always available regardless of Garbo configuration.",
    },
  ];

  const garboConfigured = await isGarboConfigured().catch(() => false);
  if (!garboConfigured) {
    return makeResult(
      "sex_offender_nsopw",
      ["nsopw_manual_check_required"],
      {
        searched_name: fullName(lead),
        searched_state: lead.state,
        searched_zip: lead.zip,
        source: "https://www.nsopw.gov/",
        automation_policy:
          "No fake PASS. Configure a Garbo integration (Settings → Integrations → Garbo) for live automated screening, or run NSOPW manually via the smart-link.",
      },
      ["Click the smart-link below to run NSOPW. Record the result before clearing this lane."],
      undefined,
      manualUrls,
    );
  }

  // Garbo is configured — run the live check.
  const garbo = await _runGarboCheckWithOverride({
    first_name: lead.first_name ?? "",
    last_name: lead.last_name ?? "",
    date_of_birth: lead.dob ?? null,
    state: lead.state ?? null,
    email: lead.email ?? null,
    phone: lead.phone ?? null,
  });

  if (garbo.status === "unconfigured") {
    // Race: configured-check passed, then the row got disabled.
    // Degrade gracefully to the smart-link path.
    return makeResult(
      "sex_offender_nsopw",
      ["nsopw_manual_check_required"],
      { searched_name: fullName(lead), garbo_status: "unconfigured", garbo_note: garbo.note },
      ["Garbo integration disappeared between configuration check and call. Fall back to manual NSOPW lookup."],
      undefined,
      manualUrls,
    );
  }
  if (garbo.status === "error") {
    return makeResult(
      "sex_offender_nsopw",
      ["garbo_unreachable"],
      { searched_name: fullName(lead), garbo_status: "error", garbo_note: garbo.note },
      [`Garbo unreachable — falling back to manual NSOPW lookup. Reason: ${garbo.note}`],
      garbo.note,
      manualUrls,
    );
  }
  // ok
  const registryHits = garbo.hits.filter((h) => h.is_sex_offender_registry || h.category === "sexual");
  const flags: string[] = [];
  if (registryHits.length > 0) flags.push("garbo_sex_offender_hit");
  return makeResult(
    "sex_offender_nsopw",
    flags,
    {
      searched_name: fullName(lead),
      garbo_status: "ok",
      garbo_hits_total: garbo.hits.length,
      garbo_sex_offender_hits: registryHits,
      garbo_all_hits: garbo.hits,
      checked_at: garbo.checked_at,
    },
    registryHits.length > 0
      ? [`Garbo: ${registryHits.length} sex-offender registry hit${registryHits.length === 1 ? "" : "s"}.`]
      : ["Garbo: no sex-offender registry hits."],
    undefined,
    manualUrls,
  );
}

// ---------------------------------------------------------------------------
// Attorney — full automation requires per-state bar API integrations
// (10+ unique APIs, each paid or rate-limited). We emit a deep-link to
// the lead's state-of-record bar lookup where the URL is documented
// (CA, NY, TX, FL, IL, PA, OH, GA, NC, WA) and a DuckDuckGo bang
// fallback otherwise. PACER attorney-search is also surfaced for
// federal admissions.
// ---------------------------------------------------------------------------
export async function adaptAttorney(lead: LeadLike): Promise<BackgroundLaneResult> {
  const bar = stateBarSearchUrl(lead);
  const manualUrls: BackgroundLaneResult["manual_action_urls"] = [
    {
      label: bar.coverage === "deep_link"
        ? `Search ${lead.state ?? "state"} bar — prefilled`
        : `Search ${lead.state ?? "state"} bar (landing page)`,
      url: bar.url,
      note: bar.coverage === "deep_link"
        ? "Confirms attorney good-standing in their state of admission. Result loads with the lead's name prefilled."
        : "No documented deep-link for this state — landing page opens; paste the name into the form.",
    },
  ];
  return makeResult(
    "attorney",
    ["attorney_not_checked"],
    {
      searched_name: fullName(lead),
      searched_state: lead.state,
      manual_source:
        "State bar lookup required only if the lead claims attorney status or legal-entity connection.",
      coverage: bar.coverage,
    },
    [
      bar.coverage === "deep_link"
        ? "Click below to run the state bar lookup — name is prefilled."
        : "No deep-link known for this state; click below to open the search page and paste the name.",
    ],
    undefined,
    manualUrls,
  );
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
// Business entity — hybrid: live SEC EDGAR + state-SoS smart-links.
//
// SEC EDGAR covers publicly-traded companies, large LLCs, and anyone
// who's done a Reg D filing — roughly 10K entities. That's a real
// PASS-or-MATCH signal: if EDGAR returns a hit, we surface the
// CIK/ticker/filings URL and the lane goes PASS. If EDGAR returns
// no hit we still emit the smart-link to the state SoS portal for
// manual confirmation of small entities, and the lane stays REVIEW.
//
// OpenCorporates would close the small-LLC gap, but it's a paid
// integration we don't ship. Operators who pay for it can register
// a sync handler under integration-sync.ts.
// ---------------------------------------------------------------------------
export async function adaptBusiness(lead: LeadLike): Promise<BackgroundLaneResult> {
  if (!lead.business_name?.trim()) {
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
  const businessName = lead.business_name.trim();

  // SEC EDGAR live lookup. No API key required — SEC requires a polite
  // User-Agent which the client sets from EDGAR_CONTACT_EMAIL.
  let edgar: Awaited<ReturnType<typeof searchEdgar>>;
  try {
    edgar = await searchEdgar(businessName);
  } catch (err) {
    edgar = { status: "error", matches: [], fetched_at: null, note: (err as Error).message };
  }

  // SoS smart-link fallback — always emit so the operator can audit
  // small-business entities that don't show up in EDGAR.
  const sos = stateSosSearchUrl(lead);
  const manualUrls: BackgroundLaneResult["manual_action_urls"] = [];
  if (sos) {
    manualUrls.push({
      label: sos.coverage === "deep_link"
        ? `Search ${lead.state ?? "state"} Secretary of State — prefilled`
        : `Search ${lead.state ?? "state"} Secretary of State (landing page)`,
      url: sos.url,
      note: sos.coverage === "deep_link"
        ? "Confirms the entity is registered and in good standing with the state. Pre-filled with the business name."
        : "No documented deep-link for this state — landing page opens; paste the business name into the form.",
    });
  }

  if (edgar.status === "ok" && edgar.matches.length > 0) {
    // We found a registered SEC entity matching the name. PASS — but
    // surface the matches so the operator can sanity-check that the
    // CIK is actually the right company (name collisions are rare but
    // non-zero — "Apple Inc" vs "Apple Corps", for example).
    return makeResult(
      "business_entity",
      [],
      {
        business_name: businessName,
        sec_matches: edgar.matches,
        fetched_at: edgar.fetched_at,
      },
      [`SEC EDGAR: ${edgar.matches.length} registered entity match${edgar.matches.length === 1 ? "" : "es"} found.`],
      undefined,
      manualUrls,
    );
  }

  // No SEC hit OR SEC was unreachable. Surface as manual-review with
  // smart-links; this is the common case for small LLCs / partnerships.
  const flags = edgar.status === "error"
    ? ["manual_entity_check_required"] // EDGAR unreachable — still need a manual check
    : ["manual_entity_check_required"]; // No EDGAR hit — small entity, manual check
  return makeResult(
    "business_entity",
    flags,
    {
      business_name: businessName,
      sec_matches: [],
      sec_status: edgar.status,
      sec_note: edgar.note,
      fetched_at: edgar.fetched_at,
      manual_sources: ["Secretary of State (NASS directory)", "OpenCorporates (paid)", "SAM.gov (federal contractors)"],
    },
    [
      edgar.status === "error"
        ? `SEC EDGAR unreachable: ${edgar.note}. Falling back to manual SoS lookup.`
        : "Not found in SEC EDGAR (entity is below SEC reporting threshold or unregistered with SEC). Run the state SoS lookup below.",
    ],
    undefined,
    manualUrls,
  );
}

// ---------------------------------------------------------------------------
// Phone provenance — live carrier + line-type + portability lookup via
// Telnyx Number Lookup. Reuses the existing `telnyx` integration row's
// api_key (set up for SMS send) so most operators get this lane "free"
// the moment they enable Telnyx SMS. Classifies into low/moderate/high
// burner-risk; high-risk verdicts (non-fixed-VOIP, known burner
// carriers) emit REVIEW flags so a paralegal looks before the lead
// gets routed to a buyer.
// ---------------------------------------------------------------------------
export async function adaptPhoneProvenance(lead: LeadLike): Promise<BackgroundLaneResult> {
  const phone = (lead.phone ?? "").trim();
  if (!phone) {
    return makeResult("phone_provenance", ["phone_provenance_unconfigured"], { phone: null }, [
      "No phone on lead — provenance check skipped.",
    ]);
  }
  // Pass the firm context through if the LeadLike has it available; we
  // intentionally don't require it (the helper falls back to env when
  // there's no integration row, so single-firm deployments keep working).
  const result = await _lookupPhoneProvenanceWithOverride(phone);
  const flags = [...result.flags];
  return makeResult(
    "phone_provenance",
    flags,
    {
      phone: result.phone,
      line_type: result.line_type,
      carrier: result.carrier,
      country_code: result.country_code,
      recently_ported: result.recently_ported,
      risk: result.risk,
      status: result.status,
      note: result.note,
    },
    result.note ? [result.note] : [],
  );
}

