import dnsPromises from "node:dns/promises";

import { auditLog } from "../audit";
import { runBackgroundCheck } from "../background-check";
import { validateAddress as validateAddressInternal } from "../address-validator";
import { validateEmail as validateEmailInternal } from "../email-validator";
import { logger } from "../logger";
import { searchPcl } from "../pacer/pcl-client";

import { BACKGROUND_SOURCES } from "./sources";
import { statusFromFlags } from "./escalation";
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
// Residency — honest stub. We have no live county-property-records adapter.
// ---------------------------------------------------------------------------
export async function adaptResidency(lead: LeadLike): Promise<BackgroundLaneResult> {
  const haveAddress = Boolean(lead.address && lead.city && lead.state);
  const flags = haveAddress ? ["no_residency_corroboration"] : ["residency_not_checked"];
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
// Incarceration — honest stub. Federal BOP has no stable JSON API.
// ---------------------------------------------------------------------------
export async function adaptIncarceration(lead: LeadLike): Promise<BackgroundLaneResult> {
  return makeResult(
    "incarceration",
    ["incarceration_check_not_run"],
    {
      searched_name: fullName(lead),
      manual_sources: ["Federal BOP Inmate Locator", "State DOC", "County jail lookup"],
    },
    ["Operator: BOP/DOC lookups must be done by hand — no live adapter wired."],
  );
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
// Attorney — honest stub. State bar lookups vary state-to-state.
// ---------------------------------------------------------------------------
export async function adaptAttorney(lead: LeadLike): Promise<BackgroundLaneResult> {
  return makeResult(
    "attorney",
    ["attorney_not_checked"],
    {
      searched_name: fullName(lead),
      manual_source:
        "State bar lookup required only if the lead claims attorney status or legal-entity connection.",
    },
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
// Business entity — honest stub. SAM.gov and Secretary-of-State searches
// are not wired. Skipped entirely (NOT_RUN) when the lead has no business name.
// ---------------------------------------------------------------------------
export async function adaptBusiness(lead: LeadLike): Promise<BackgroundLaneResult> {
  if (!lead.business_name?.trim()) {
    // Use NOT_RUN directly because the precondition isn't met. Bypass
    // the flag taxonomy here — there are no flags to score.
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
  return makeResult(
    "business_entity",
    ["manual_entity_check_required"],
    {
      business_name: lead.business_name,
      manual_sources: ["Secretary of State (NASS directory)", "SAM.gov", "OpenCorporates"],
    },
  );
}
