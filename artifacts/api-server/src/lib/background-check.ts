import { logger } from "./logger";
import { getCourtsForState, getStateLabel, normalizeStateCode } from "./courtlistener-courts";
import { isTreasurySdnEnabled, matchTreasurySdn } from "./ofac-treasury";

export interface BackgroundCheckResult {
  status: "clean" | "flagged" | "not_found" | "error";
  source: string;
  checked_at: string;
  records: BackgroundRecord[];
  summary: string;
  /** Which jurisdictional scope was searched. */
  search_scope: "state" | "national" | "national-fallback";
  /** The 2-letter state code that was effectively used (null if none). */
  searched_state: string | null;
  /** Human-readable label for `searched_state`. */
  searched_state_label: string | null;
  /** CourtListener court IDs queried (empty when nationwide). */
  searched_courts: string[];
  /** Operator-facing notes about source health, fallbacks, or limitations. */
  notes: string[];
}

export interface BackgroundRecord {
  type: string;
  description: string;
  date?: string;
  jurisdiction?: string;
  severity: "low" | "medium" | "high";
  role?: "party" | "mentioned";
}

export async function runBackgroundCheck(person: {
  first_name: string;
  last_name: string;
  state?: string;
  date_of_birth?: string;
}): Promise<BackgroundCheckResult> {
  const checkedAt = new Date().toISOString();
  const fullName = `${person.first_name} ${person.last_name}`;
  const notes: string[] = [];

  // Resolve search scope from the state input.
  const stateCode = normalizeStateCode(person.state);
  const stateLabel = getStateLabel(person.state);
  let courts = stateCode ? getCourtsForState(stateCode) : [];
  let searchScope: BackgroundCheckResult["search_scope"];

  if (person.state && !stateCode) {
    // Caller provided a state value we don't recognize — fall back nationwide
    // and tell the operator. This prevents silently dropping the filter.
    searchScope = "national-fallback";
    notes.push(
      `Provided state "${person.state}" is not a recognized US state — searched nationwide federal courts instead.`,
    );
  } else if (stateCode && courts.length === 0) {
    searchScope = "national-fallback";
    notes.push(
      `No federal court coverage in CourtListener for ${stateLabel ?? stateCode} — searched nationwide federal courts instead.`,
    );
  } else if (stateCode && courts.length > 0) {
    searchScope = "state";
  } else {
    searchScope = "national";
  }

  try {
    const results: BackgroundRecord[] = [];
    let sourcesReached = 0;

    const courtRecords = await searchCourtRecords(person, courts);
    if (courtRecords !== null) {
      sourcesReached++;
      results.push(...courtRecords);
    } else {
      notes.push("Court records source (CourtListener) was unreachable.");
    }

    const ofacResult = await checkOFACList(person);
    if (ofacResult.status === "ok") {
      sourcesReached++;
      results.push(...ofacResult.records);
    } else {
      // OFAC check is "best effort" — degrade gracefully so the rest of the
      // pipeline can still succeed, but be honest in the audit trail.
      notes.push(ofacResult.note);
    }

    if (sourcesReached === 0) {
      return {
        status: "error",
        source: "MTOS Background Check (Court Records + OFAC)",
        checked_at: checkedAt,
        records: [],
        summary: `All background check sources unreachable for ${fullName}`,
        search_scope: searchScope,
        searched_state: stateCode,
        searched_state_label: stateLabel,
        searched_courts: courts,
        notes,
      };
    }

    const partyRecords = results.filter((r) => r.role === "party");
    const mentionRecords = results.filter((r) => r.role === "mentioned");
    const nonCourtRecords = results.filter((r) => r.type !== "COURT_RECORD");
    const hasFlaggable = partyRecords.length > 0 || nonCourtRecords.length > 0;
    const status = hasFlaggable ? "flagged" : "clean";

    const parts: string[] = [];
    if (partyRecords.length > 0) {
      parts.push(`${partyRecords.length} case(s) as named party`);
    }
    if (mentionRecords.length > 0) {
      parts.push(`${mentionRecords.length} mention(s) in other cases`);
    }
    if (nonCourtRecords.length > 0) {
      parts.push(`${nonCourtRecords.length} non-court record(s)`);
    }

    let scopeBlurb: string;
    if (searchScope === "state" && stateLabel) {
      scopeBlurb = `${stateLabel} federal courts`;
    } else if (searchScope === "national-fallback") {
      scopeBlurb = "nationwide federal courts (state filter not applied)";
    } else {
      scopeBlurb = "nationwide federal courts";
    }
    const headline = parts.length > 0
      ? `${parts.join(", ")} for ${fullName}`
      : `No federal records found for ${fullName}`;
    const summary = `${headline} (searched ${scopeBlurb})`;

    return {
      status,
      source: "MTOS Background Check (Court Records + OFAC)",
      checked_at: checkedAt,
      records: results,
      summary,
      search_scope: searchScope,
      searched_state: stateCode,
      searched_state_label: stateLabel,
      searched_courts: courts,
      notes,
    };
  } catch (err) {
    logger.error({ err, person: fullName }, "Background check failed");
    return {
      status: "error",
      source: "MTOS Background Check",
      checked_at: checkedAt,
      records: [],
      summary: `Background check error for ${fullName}: ${err instanceof Error ? err.message : "Unknown error"}`,
      search_scope: searchScope,
      searched_state: stateCode,
      searched_state_label: stateLabel,
      searched_courts: courts,
      notes,
    };
  }
}

function textContainsName(
  text: string,
  firstName: string,
  lastName: string,
): "exact" | "initial" | false {
  const t = text.toLowerCase();
  const fn = firstName.toLowerCase();
  const ln = lastName.toLowerCase();

  if (t.includes(`${fn} ${ln}`) || t.includes(`${ln}, ${fn}`) || t.includes(`${ln} ${fn}`)) {
    return "exact";
  }

  const fnInitial = fn.charAt(0);
  if (
    t.includes(`${ln}, ${fnInitial}.`) ||
    t.includes(`${ln}, ${fnInitial} `) ||
    t.includes(`${fnInitial}. ${ln}`)
  ) {
    return "initial";
  }

  return false;
}

interface CourtResult {
  caseName?: string;
  dateFiled?: string;
  court?: string;
  docketNumber?: string;
  party?: string[];
  recap_documents?: Array<{
    description?: string;
    snippet?: string;
  }>;
}

/**
 * Returns true when first-name evidence appears anywhere in the result —
 * case name, party list, or RECAP document text. Used to demote pure
 * surname-only matches that would otherwise produce false positives for
 * common surnames (e.g. "X v. Pereira" without "Giselle" anywhere).
 */
function hasFirstNameEvidence(
  result: CourtResult,
  firstName: string,
  lastName: string,
): boolean {
  const haystack = [
    result.caseName || "",
    ...(result.party || []),
    ...(result.recap_documents || []).map((d) => `${d.description || ""} ${d.snippet || ""}`),
  ].join(" ");
  return textContainsName(haystack, firstName, lastName) !== false;
}

function lastNameIsDefendant(
  result: CourtResult,
  lastName: string,
): boolean {
  const ln = lastName.toLowerCase();
  const cn = (result.caseName || "").toLowerCase();

  const defPattern = /\s+v\.?\s+(.+)/i;
  const defMatch = cn.match(defPattern);
  if (defMatch) {
    const defSide = defMatch[1].trim();
    if (defSide === ln || defSide.startsWith(`${ln},`) || defSide.startsWith(`${ln} `)) {
      return true;
    }
  }

  if (result.party && Array.isArray(result.party)) {
    for (const p of result.party) {
      const pl = p.toLowerCase().trim();
      if (pl === ln || pl === ln.toUpperCase().toLowerCase()) {
        return true;
      }
    }
  }

  return false;
}

/**
 * Decide whether a CourtListener result actually matches the person we're
 * checking. Returns confidence + role; `match=false` means skip entirely.
 *
 * Critical: we never claim "party" role purely on a last-name "v. <ln>"
 * pattern — common surnames (Pereira, Smith, Garcia) generate hundreds of
 * unrelated "X v. Pereira" hits. We require first-name evidence somewhere
 * in the result before claiming the person is a named party.
 */
export function nameMatchesResult(
  result: CourtResult,
  firstName: string,
  lastName: string,
): { match: boolean; confidence: "exact" | "strong" | "none"; role: "party" | "mentioned" } {
  const caseName = result.caseName || "";

  // 1. Direct first+last in case name → exact party match
  const caseMatch = textContainsName(caseName, firstName, lastName);
  if (caseMatch === "exact") return { match: true, confidence: "exact", role: "party" };
  if (caseMatch === "initial") return { match: true, confidence: "strong", role: "party" };

  // 2. Split case sides ("Smith v. Jones") and check each for first+last
  const caseParties = caseName.split(/\s+v\.?\s+|\s+vs\.?\s+|\s+and\s+/i);
  for (const party of caseParties) {
    const pm = textContainsName(party.trim(), firstName, lastName);
    if (pm) return { match: true, confidence: pm === "exact" ? "exact" : "strong", role: "party" };
  }

  // 3. Party list explicitly contains both names
  if (result.party && Array.isArray(result.party)) {
    for (const p of result.party) {
      const pm = textContainsName(p, firstName, lastName);
      if (pm) return { match: true, confidence: pm === "exact" ? "exact" : "strong", role: "party" };
    }
  }

  // 4. "X v. <lastName>" pattern — only count as party if first name appears
  //    elsewhere in the result (party list or recap docs). Otherwise it's
  //    almost certainly a different person with the same surname.
  if (lastNameIsDefendant(result, lastName)) {
    if (hasFirstNameEvidence(result, firstName, lastName)) {
      return { match: true, confidence: "strong", role: "party" };
    }
    // Surname-only — skip entirely instead of producing a false-positive
    // medium-severity "named party" record.
    return { match: false, confidence: "none", role: "mentioned" };
  }

  // 5. Mention in RECAP document text — low-severity reference, only when
  //    BOTH names appear together (not just the surname).
  if (result.recap_documents && Array.isArray(result.recap_documents)) {
    for (const doc of result.recap_documents) {
      const searchable = `${doc.description || ""} ${doc.snippet || ""}`;
      const dm = textContainsName(searchable, firstName, lastName);
      if (dm) return { match: true, confidence: "strong", role: "mentioned" };
    }
  }

  return { match: false, confidence: "none", role: "mentioned" };
}

async function fetchCourtListenerResults(
  query: string,
  courtFilter: string,
): Promise<CourtResult[] | null> {
  const url = `https://www.courtlistener.com/api/rest/v4/search/?q=${encodeURIComponent(query)}&type=r${courtFilter}&format=json`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  try {
    const response = await fetch(url, {
      headers: { "User-Agent": "MTOS-CRM/1.0 (Legal Background Check)" },
      signal: controller.signal,
    });
    clearTimeout(timeout);
    if (!response.ok) {
      logger.warn({ status: response.status, query }, "CourtListener returned non-OK status");
      return null;
    }
    const data = (await response.json()) as { results?: CourtResult[] };
    return data.results || [];
  } catch (err) {
    clearTimeout(timeout);
    logger.warn({ err, query }, "CourtListener fetch failed");
    return null;
  }
}

async function searchCourtRecords(
  person: { first_name: string; last_name: string },
  courts: string[],
): Promise<BackgroundRecord[] | null> {
  const firstName = person.first_name.trim();
  const lastName = person.last_name.trim();
  const courtFilter = courts.length > 0
    ? `&court=${encodeURIComponent(courts.join(","))}`
    : "";

  const exactSearches = [
    `"${firstName} ${lastName}"`,
    `"${lastName}, ${firstName}"`,
  ];
  const defendantSearch = `"v. ${lastName}"`;
  const broadSearch = `${lastName} AND ${firstName}`;

  const seen = new Set<string>();
  const records: BackgroundRecord[] = [];
  let anySourceReached = false;

  function buildRecord(
    result: CourtResult,
    role: "party" | "mentioned",
    confidence: "exact" | "strong" | "none",
  ): BackgroundRecord {
    const caseName = result.caseName || "Court record found";
    let severity: "low" | "medium" | "high";
    let description: string;

    if (role === "party") {
      if (confidence === "exact") {
        severity = "high";
        description = caseName;
      } else {
        severity = "medium";
        description = `${caseName} (name-initial match — verify identity)`;
      }
    } else {
      severity = "low";
      description = `${caseName} (named in documents, not a listed party)`;
    }

    return {
      type: "COURT_RECORD",
      description,
      date: result.dateFiled || undefined,
      jurisdiction: result.court || undefined,
      severity,
      role,
    };
  }

  const exactBatches = await Promise.all(
    exactSearches.map((q) => fetchCourtListenerResults(q, courtFilter)),
  );
  for (const batch of exactBatches) {
    if (batch === null) continue;
    anySourceReached = true;
    for (const result of batch) {
      const docketNum = result.docketNumber || "";
      const caseName = result.caseName || "";
      const key = `${docketNum}|${caseName}|${result.dateFiled || ""}`;
      if (seen.has(key)) continue;
      seen.add(key);

      const { match, confidence, role } = nameMatchesResult(result, firstName, lastName);
      if (!match) continue;
      records.push(buildRecord(result, role, confidence));
    }
  }

  const defResults = await fetchCourtListenerResults(defendantSearch, courtFilter);
  if (defResults !== null) {
    anySourceReached = true;
    for (const result of defResults) {
      const docketNum = result.docketNumber || "";
      const caseName = result.caseName || "";
      const key = `${docketNum}|${caseName}|${result.dateFiled || ""}`;
      if (seen.has(key)) continue;
      seen.add(key);

      // Require BOTH (a) lastName-as-defendant pattern AND (b) first-name
      // evidence somewhere. Surname-only hits are dropped — they're the
      // primary source of false positives for common surnames.
      if (!lastNameIsDefendant(result, lastName)) continue;
      if (!hasFirstNameEvidence(result, firstName, lastName)) continue;

      // Skip if a different person with the same surname is in the party
      // list (e.g., "Pereira, Maria" when we're checking "Pereira, Giselle").
      const otherFirstNames = (result.party || []).some((p) => {
        const pl = p.toLowerCase().trim();
        return pl !== lastName.toLowerCase()
          && pl !== "united states"
          && pl !== "usa"
          && pl.includes(lastName.toLowerCase())
          && !pl.includes(firstName.toLowerCase());
      });
      if (otherFirstNames) continue;

      records.push(buildRecord(result, "party", "exact"));
    }
  }

  const broadResults = await fetchCourtListenerResults(broadSearch, courtFilter);
  if (broadResults !== null) {
    anySourceReached = true;
    for (const result of broadResults) {
      const docketNum = result.docketNumber || "";
      const caseName = result.caseName || "";
      const key = `${docketNum}|${caseName}|${result.dateFiled || ""}`;
      if (seen.has(key)) continue;
      seen.add(key);

      const { match, confidence, role } = nameMatchesResult(result, firstName, lastName);
      if (!match) continue;
      records.push(buildRecord(result, role, confidence));
    }
  }

  if (!anySourceReached) return null;

  // Deduplicate again by description+jurisdiction in case multiple search
  // strategies surfaced the same case under slightly different docket numbers.
  const finalSeen = new Set<string>();
  const deduped: BackgroundRecord[] = [];
  for (const rec of records) {
    const key = `${rec.description}|${rec.jurisdiction || ""}|${rec.date || ""}`;
    if (finalSeen.has(key)) continue;
    finalSeen.add(key);
    deduped.push(rec);
  }

  return deduped.slice(0, 10);
}

type OFACOutcome =
  | { status: "ok"; records: BackgroundRecord[] }
  | { status: "unconfigured"; note: string }
  | { status: "error"; note: string };

/**
 * OFAC sanctions check.
 *
 * Priority order:
 *   1. FREE — US Treasury SDN CSV (lib/ofac-treasury.ts). Active by default
 *      (`OFAC_USE_TREASURY=1`). Downloads the canonical Specially Designated
 *      Nationals list directly from treasury.gov — no API key, no vendor, same
 *      data every paid screening service wraps. Cached in-memory; refreshes
 *      daily. Disable with `OFAC_USE_TREASURY=0` to use the paid path instead.
 *   2. PAID — search.ofac-api.com/v3 (legacy). Only reached when Treasury is
 *      disabled AND `OFAC_API_KEY` is set.
 *   3. UNCONFIGURED — both disabled/missing → honest "skipped" note so the
 *      caller never fabricates a clean result.
 */
async function checkOFACList(person: {
  first_name: string;
  last_name: string;
}): Promise<OFACOutcome> {
  // --- Path 1: free Treasury SDN list (default ON) ---
  if (isTreasurySdnEnabled()) {
    try {
      const result = await matchTreasurySdn({
        first_name: person.first_name,
        last_name: person.last_name,
      });
      if (result.status === "error") {
        return {
          status: "error",
          note: `OFAC Treasury SDN check failed: ${result.note ?? "unknown error"}`,
        };
      }
      const records: BackgroundRecord[] = result.matches.map((m) => ({
        type: "OFAC_SANCTIONS",
        description: `OFAC SDN match: ${m.name} (Programs: ${m.programs.join(", ") || "N/A"}) [via ${m.matched_via}]`,
        severity: "high" as const,
      }));
      return { status: "ok", records };
    } catch (err) {
      logger.warn({ err }, "OFAC Treasury SDN check threw unexpectedly");
      return {
        status: "error",
        note: `OFAC Treasury SDN unavailable: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  // --- Path 2: paid third-party API (opt-in via OFAC_USE_TREASURY=0 + OFAC_API_KEY) ---
  const apiKey = process.env.OFAC_API_KEY;
  if (!apiKey) {
    return {
      status: "unconfigured",
      note: "OFAC sanctions check skipped — Treasury SDN disabled and no OFAC_API_KEY set.",
    };
  }

  try {
    const name = encodeURIComponent(`${person.first_name} ${person.last_name}`);
    const url = `https://search.ofac-api.com/v3?name=${name}&minScore=95&apikey=${encodeURIComponent(apiKey)}`;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    const response = await fetch(url, { signal: controller.signal });
    clearTimeout(timeout);

    if (!response.ok) {
      return {
        status: "error",
        note: `OFAC sanctions check unavailable (provider returned HTTP ${response.status}).`,
      };
    }

    const data = await response.json() as {
      matches?: Array<{ name?: string; programs?: string[]; score?: number }>;
    };
    const records: BackgroundRecord[] = [];
    if (data.matches && Array.isArray(data.matches) && data.matches.length > 0) {
      for (const match of data.matches.slice(0, 5)) {
        records.push({
          type: "OFAC_SANCTIONS",
          description: `OFAC match: ${match.name || "Unknown"} (Programs: ${match.programs?.join(", ") || "N/A"})`,
          severity: "high",
        });
      }
    }
    return { status: "ok", records };
  } catch (err) {
    logger.warn({ err }, "OFAC check failed");
    return {
      status: "error",
      note: `OFAC sanctions check unavailable (${err instanceof Error ? err.message : "unknown error"}).`,
    };
  }
}
