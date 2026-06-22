// Provider verification against the CMS NPI Registry.
//
// Port of the Python verify_provider() reference: given a claimed provider
// profile (name, organization, city, state, specialty) and an optional NPI,
// hit the CMS NPI Registry, pick the best candidate when multiple match,
// score each field, and return a verified verdict + confidence + per-check
// breakdown. Used by operators to confirm an NPI claim attached to a lead
// before promoting it to a case.
//
// Distinct from lookupNpiAndMatch() in taxonomy-engine.ts, which is a
// thinner first-result-only path used by the public form pipeline.
import { logger } from "./logger";
import {
  normalize,
  similarity,
  similarityName,
  similarityPreNormalized,
  similarityNamePreNormalized,
} from "./string-similarity";

const NPI_API_BASE = "https://npiregistry.cms.hhs.gov/api/";
const NPI_VERSION = "2.1";
const HTTP_TIMEOUT_MS = 10_000;
const NPI_USER_AGENT = "MTOS-NPPES-Verifier/1.0";
const NPI_MAX_RETRIES = 2; // 1 initial + 2 retries = 3 attempts total

// Specialty aliases: when an operator types "general practitioner" we want the
// taxonomy match to also accept "general practice", "family medicine", or
// "internal medicine" — those are the actual NPPES taxonomy descriptions for
// the same job. Without this, perfectly valid NPIs scored 0 on specialty.
const SPECIALTY_ALIASES: Record<string, readonly string[]> = {
  "general practitioner": ["general practice", "family medicine", "internal medicine"],
  "general practice": ["family medicine", "internal medicine"],
  "family doctor": ["family medicine", "general practice"],
  "primary care": ["family medicine", "internal medicine", "general practice"],
};

class NppesUnavailable extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NppesUnavailable";
  }
}

interface NpiAddress {
  address_purpose?: string;
  address_1?: string;
  address_2?: string;
  city?: string;
  state?: string;
  postal_code?: string;
  telephone_number?: string;
  fax_number?: string;
}

interface NpiTaxonomy {
  code?: string;
  desc?: string;
  primary?: boolean;
}

interface NpiBasic {
  name?: string;
  first_name?: string;
  last_name?: string;
  organization_name?: string;
  credential?: string;
  enumeration_date?: string;
}

interface NpiRegistryResult {
  number?: number | string;
  enumeration_type?: string;
  basic?: NpiBasic;
  addresses?: NpiAddress[];
  taxonomies?: NpiTaxonomy[];
}

export interface ExpectedProvider {
  name?: string;
  organization?: string;
  city?: string;
  state?: string;
  specialty?: string;
}

export interface VerifyProviderInput {
  npi?: string;
  expected: ExpectedProvider;
}

export interface ProviderSummary {
  npi: string;
  name: string;
  organization_name: string;
  taxonomies: Array<{ code: string; desc: string; primary: boolean }>;
  address: {
    address_1: string;
    city: string;
    state: string;
    postal_code: string;
  };
  // Surfaced for downstream automation (e.g. faxing a HIPAA medical-records
  // request to the verified provider). NPPES returns these on the practice
  // LOCATION address; either may be blank if the provider never registered one.
  phone: string;
  fax: string;
}

// Three-way honest verdict: VERIFIED means we got data back from NPPES and
// every gate passed; MISMATCH means we got data back but a gate failed;
// UNAVAILABLE means we could NOT reach NPPES at all (network failure, HTTP
// error, non-JSON response). UNAVAILABLE must NEVER be downgraded to
// MISMATCH — that would be a silent-pass-style honesty bug, the same family
// the BG hub OFAC fix addresses.
export type VerifyProviderStatus = "VERIFIED" | "MISMATCH" | "UNAVAILABLE";

export interface VerifyProviderResult {
  method: "npi" | "name_search" | null;
  provider: ProviderSummary | null;
  status: VerifyProviderStatus;
  checks: {
    npi_lookup?: { found: boolean; npi?: string; message?: string; error?: string };
    search?: { found: boolean; candidates_returned?: number; best_score?: number; message?: string; error?: string };
    name?: { expected: string; provider: string; score: number; match: boolean };
    organization?: { expected: string; provider: string; score: number; match: boolean };
    location?: {
      expected_city: string;
      provider_city: string;
      city_score: number;
      city_match: boolean;
      expected_state: string;
      provider_state: string;
      state_score: number;
      state_match: boolean;
    };
    specialty?: {
      expected_specialty: string;
      taxonomy_matches: Array<{ code: string; desc: string; primary: boolean }>;
      all_taxonomies: string[];
      match: boolean;
    };
    decision_thresholds?: {
      identity_score: number;
      identity_ok: boolean;
      city_score: number;
      city_ok: boolean;
      state_score: number;
      state_ok: boolean;
      specialty_ok: boolean;
    };
  };
  verified: boolean;
  confidence: number;
  candidates_returned?: number;
}

async function fetchNpiOnce(params: URLSearchParams): Promise<NpiRegistryResult[]> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);
  try {
    const url = `${NPI_API_BASE}?${params.toString()}`;
    const r = await fetch(url, {
      signal: controller.signal,
      // Identified User-Agent + JSON Accept header. NPPES is friendlier to
      // identified clients and is more likely to rate-limit anonymous ones.
      headers: { "User-Agent": NPI_USER_AGENT, Accept: "application/json" },
    });
    if (!r.ok) {
      // Treat HTTP failure as transient/unavailable — the honest bucket.
      throw new NppesUnavailable(`NPPES returned HTTP ${r.status}`);
    }
    let data: { results?: NpiRegistryResult[] };
    try {
      data = (await r.json()) as { results?: NpiRegistryResult[] };
    } catch (err) {
      throw new NppesUnavailable(
        `NPPES returned non-JSON response: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    return data.results ?? [];
  } catch (err) {
    if (err instanceof NppesUnavailable) throw err;
    // AbortError, network errors, etc. — wrap.
    throw new NppesUnavailable(err instanceof Error ? err.message : String(err));
  } finally {
    clearTimeout(timeout);
  }
}

// Retry wrapper with linear backoff for transient NPPES failures. Only
// NppesUnavailable is retried — anything else propagates immediately.
async function fetchNpi(params: URLSearchParams): Promise<NpiRegistryResult[]> {
  let lastErr: NppesUnavailable | null = null;
  for (let attempt = 0; attempt <= NPI_MAX_RETRIES; attempt++) {
    try {
      return await fetchNpiOnce(params);
    } catch (err) {
      if (!(err instanceof NppesUnavailable)) throw err;
      lastErr = err;
      if (attempt < NPI_MAX_RETRIES) {
        const backoffMs = 250 * (attempt + 1);
        await new Promise((resolve) => setTimeout(resolve, backoffMs));
      }
    }
  }
  throw lastErr ?? new NppesUnavailable("NPPES request failed");
}

// Pick the most relevant address from an NPPES record. NPPES may return
// MAILING and LOCATION (practice) addresses; LOCATION is what we want for
// "where do they actually work" matching. Falls back to MAILING, then any.
function pickPrimaryAddress(addresses: NpiAddress[] | undefined): NpiAddress {
  const list = addresses ?? [];
  return (
    list.find((a) => a.address_purpose === "LOCATION") ??
    list.find((a) => a.address_purpose === "MAILING") ??
    list[0] ??
    {}
  );
}

async function lookupByNpi(npi: string): Promise<NpiRegistryResult | null> {
  const params = new URLSearchParams({ number: npi, version: NPI_VERSION });
  const results = await fetchNpi(params);
  return results[0] ?? null;
}

async function searchByNameLocation(
  expected: ExpectedProvider,
  limit = 20,
): Promise<NpiRegistryResult[]> {
  const params = new URLSearchParams({ version: NPI_VERSION, limit: String(limit) });

  // Extract first/last from a free-text name if provided
  const nameParts = (expected.name ?? "").trim().split(/\s+/).filter(Boolean);
  if (nameParts.length >= 1) params.set("first_name", nameParts[0]);
  if (nameParts.length >= 2) params.set("last_name", nameParts[nameParts.length - 1]);

  if (expected.organization) params.set("organization_name", expected.organization);
  if (expected.city) params.set("city", expected.city);
  if (expected.state) params.set("state", expected.state);

  return fetchNpi(params);
}

function pickBestSearchResult(
  results: NpiRegistryResult[],
  expected: ExpectedProvider,
): { best: NpiRegistryResult; score: number } | null {
  let best: NpiRegistryResult | null = null;
  let bestScore = -1;

  const normExpName = normalize(expected.name);
  const normExpOrg = normalize(expected.organization);
  const normExpCity = normalize(expected.city);
  const normExpState = normalize(expected.state);

  for (const r of results) {
    const basic = r.basic ?? {};
    const name = basic.name || `${basic.first_name || ""} ${basic.last_name || ""}`.trim();
    const normName = normalize(name);

    const org = basic.organization_name ?? "";
    const normOrg = normalize(org);

    const primaryAddr = pickPrimaryAddress(r.addresses);
    const normCity = normalize(primaryAddr.city);
    const normState = normalize(primaryAddr.state);

    const nameScore = Math.max(
      similarityNamePreNormalized(normName, normExpName),
      similarityNamePreNormalized(normOrg, normExpName),
    );
    const orgScore = similarityPreNormalized(normOrg, normExpOrg);
    const cityScore = similarityPreNormalized(normCity, normExpCity);
    const stateScore =
      normState === normExpState ? 1.0 : similarityPreNormalized(normState, normExpState);

    // Same weighting as the Python reference: name/org max 0.5, city 0.25, state 0.25
    const score = 0.5 * Math.max(nameScore, orgScore) + 0.25 * cityScore + 0.25 * stateScore;
    if (score > bestScore) {
      bestScore = score;
      best = r;
      if (score >= 1.0) break; // Early break on perfect match
    }
  }

  return best ? { best, score: bestScore } : null;
}

// Build the set of accepted specialty terms for matching. Always includes
// the operator-supplied term verbatim plus any aliases registered in
// SPECIALTY_ALIASES. All terms are normalized for case-insensitive substring
// comparison against NPPES taxonomy descriptions.
function specialtyAcceptedTerms(expectedSpecialty: string): string[] {
  const base = normalize(expectedSpecialty);
  if (!base) return [];
  const aliases = SPECIALTY_ALIASES[base] ?? [];
  const all = [base, ...aliases].map((t) => normalize(t)).filter(Boolean);
  return Array.from(new Set(all));
}

function providerTaxonomyMatches(
  provider: NpiRegistryResult,
  expectedSpecialty: string,
): { matched: boolean; matched_taxonomies: Array<{ code: string; desc: string; primary: boolean }>; all_descs: string[] } {
  const terms = specialtyAcceptedTerms(expectedSpecialty);
  const taxonomies = provider.taxonomies ?? [];
  const matchedTaxonomies: Array<{ code: string; desc: string; primary: boolean }> = [];
  if (terms.length > 0) {
    for (const t of taxonomies) {
      const desc = t.desc ?? "";
      if (!desc) continue;
      const descNorm = normalize(desc);
      // Substring match either direction so "family medicine" matches
      // "Family Medicine - Sports Medicine Physician" and so on.
      if (terms.some((term) => descNorm.includes(term) || term.includes(descNorm))) {
        matchedTaxonomies.push({ code: t.code ?? "", desc, primary: !!t.primary });
      }
    }
  }
  const allDescs = taxonomies.map((t) => t.desc ?? "").filter(Boolean);
  return {
    matched: matchedTaxonomies.length > 0,
    matched_taxonomies: matchedTaxonomies,
    all_descs: allDescs,
  };
}

function compareStringsField(
  providerValue: string | null | undefined,
  expectedValue: string | null | undefined,
  threshold = 0.8,
  expectedNormalized?: string,
): { match: boolean; score: number } {
  if (!expectedValue) return { match: true, score: 1.0 };
  const normExp = expectedNormalized ?? normalize(expectedValue);
  const score = similarityPreNormalized(normalize(providerValue), normExp);
  return { match: score >= threshold, score };
}

function summarizeProvider(p: NpiRegistryResult): ProviderSummary {
  const basic = p.basic ?? {};
  // Prefer practice LOCATION over MAILING — mailing addresses for big
  // hospital systems often resolve to a corporate PO box hundreds of miles
  // from the actual practice, which would tank city scoring.
  const primary = pickPrimaryAddress(p.addresses);
  return {
    npi: String(p.number ?? ""),
    name: basic.name || `${basic.first_name || ""} ${basic.last_name || ""}`.trim(),
    organization_name: basic.organization_name ?? "",
    taxonomies: (p.taxonomies ?? []).map((t) => ({
      code: t.code ?? "",
      desc: t.desc ?? "",
      primary: !!t.primary,
    })),
    address: {
      address_1: primary.address_1 ?? "",
      city: primary.city ?? "",
      state: primary.state ?? "",
      postal_code: primary.postal_code ?? "",
    },
    phone: primary.telephone_number ?? "",
    fax: primary.fax_number ?? "",
  };
}

/**
 * Verify a claimed provider against the CMS NPI Registry.
 *
 * Strategy:
 *   1. If `npi` is supplied, look up directly. The NPI is the source of truth
 *      for who the provider is — but we still score the claimed name/org/
 *      city/state/specialty against the registry record so the operator
 *      sees whether the claim is internally consistent.
 *   2. If no `npi`, search by name + city + state and pick the best fuzzy
 *      candidate. Then run the same scoring path.
 *
 * Decision: verified = identity_ok AND location_ok AND specialty_ok.
 *   - identity_ok: max(name, organization) similarity >= 0.7
 *   - location_ok: city similarity >= 0.8 AND (state exact OR similarity >= 0.9)
 *   - specialty_ok: any taxonomy desc contains the expected specialty (normalized)
 *
 * Confidence is a continuous 0..1 weighted average for ranking close calls;
 * `verified` is the boolean threshold check the UI surfaces.
 */
export async function verifyProvider(
  input: VerifyProviderInput,
): Promise<VerifyProviderResult> {
  const expected = input.expected ?? {};
  const result: VerifyProviderResult = {
    method: null,
    provider: null,
    // Default to MISMATCH — flips to VERIFIED on success or UNAVAILABLE if
    // ANY NPPES call surfaced a transport-level failure. This is the same
    // honesty pattern the BG hub uses: an unreachable source must never be
    // reported the same way as a confirmed-bad result.
    status: "MISMATCH",
    checks: {},
    verified: false,
    confidence: 0,
  };

  // Track whether we ever failed to reach NPPES. If a call fails AND we
  // ultimately have no provider record to score, the verdict is UNAVAILABLE,
  // not MISMATCH. If a call fails but we still get a candidate from another
  // call, we proceed normally — the verdict reflects the data we DID get.
  let nppesReachable = true;

  let provider: NpiRegistryResult | null = null;
  // Strict NPI mode: if the caller supplied an NPI, that is the only thing we
  // are allowed to consider — a bad/unknown NPI must NOT silently fall back to
  // a name search and then return verified=true on a different person. Code
  // review caught this: would have produced misleading results.
  const npiSupplied = Boolean(input.npi);

  // 1) NPI direct lookup if supplied
  if (input.npi) {
    if (!/^\d{10}$/.test(input.npi)) {
      result.method = "npi";
      result.checks.npi_lookup = { found: false, error: "NPI must be a 10-digit number" };
    } else {
      try {
        const found = await lookupByNpi(input.npi);
        result.method = "npi";
        if (!found) {
          result.checks.npi_lookup = { found: false, message: "NPI not found in registry" };
        } else {
          result.checks.npi_lookup = { found: true, npi: input.npi };
          provider = found;
        }
      } catch (err) {
        result.method = "npi";
        if (err instanceof NppesUnavailable) nppesReachable = false;
        result.checks.npi_lookup = { found: false, error: (err as Error).message };
      }
    }
  }

  // 2) Fallback: name + city + state search — ONLY if no NPI was supplied.
  if (!provider && !npiSupplied) {
    try {
      const results = await searchByNameLocation(expected);
      if (results.length === 0) {
        result.checks.search = { found: false, message: "No matching records from NPPES search" };
      } else {
        const picked = pickBestSearchResult(results, expected);
        if (picked) {
          provider = picked.best;
          result.method = "name_search";
          result.candidates_returned = results.length;
          result.checks.search = {
            found: true,
            candidates_returned: results.length,
            best_score: round(picked.score, 3),
          };
        }
      }
    } catch (err) {
      if (err instanceof NppesUnavailable) nppesReachable = false;
      result.checks.search = { found: false, error: (err as Error).message };
    }
  }

  if (!provider) {
    // No provider record. If NPPES couldn't be reached, the honest verdict
    // is UNAVAILABLE — operators must NOT interpret this as "doesn't match".
    if (!nppesReachable) {
      result.status = "UNAVAILABLE";
    }
    return result;
  }

  result.provider = summarizeProvider(provider);

  const normExpName = normalize(expected.name);
  const normExpOrg = normalize(expected.organization);
  const normExpCity = normalize(expected.city);
  const normExpState = normalize(expected.state);

  // Per-field scoring against the resolved provider. Use similarityName
  // (title/credential aware) for the person name so "Dr. John Smith MD"
  // matches the registered "John Smith" cleanly. Inline rather than extending
  // compareStringsField so this stays opt-in to person-name compares only.
  const provName = result.provider.name || result.provider.organization_name;
  const normProvName = normalize(provName);
  const nameRawScore = expected.name
    ? similarityNamePreNormalized(normProvName, normExpName)
    : 1.0;
  const nameCheck = { score: nameRawScore, match: nameRawScore >= 0.75 };
  result.checks.name = {
    expected: expected.name ?? "",
    provider: provName,
    score: round(nameCheck.score, 3),
    match: nameCheck.match,
  };

  const provOrg = result.provider.organization_name;
  const orgCheck = compareStringsField(provOrg, expected.organization, 0.7, normExpOrg);
  result.checks.organization = {
    expected: expected.organization ?? "",
    provider: provOrg,
    score: round(orgCheck.score, 3),
    match: orgCheck.match,
  };

  const provCity = result.provider.address.city;
  const provState = result.provider.address.state;
  const normProvState = normalize(provState);
  const cityCheck = compareStringsField(provCity, expected.city, 0.85, normExpCity);
  const stateExact = normProvState === normExpState;
  const stateScore = stateExact ? 1.0 : similarityPreNormalized(normProvState, normExpState);
  result.checks.location = {
    expected_city: expected.city ?? "",
    provider_city: provCity,
    city_score: round(cityCheck.score, 3),
    city_match: cityCheck.match,
    expected_state: expected.state ?? "",
    provider_state: provState,
    state_score: round(stateScore, 3),
    state_match: stateExact,
  };

  const tax = providerTaxonomyMatches(provider, expected.specialty ?? "");
  result.checks.specialty = {
    expected_specialty: expected.specialty ?? "",
    taxonomy_matches: tax.matched_taxonomies,
    all_taxonomies: tax.all_descs,
    match: tax.matched,
  };

  // Confidence: weighted average. Pick best of name/org as identity score.
  const identityScore = Math.max(nameCheck.score, orgCheck.score);
  const locationScore = 0.5 * cityCheck.score + 0.5 * stateScore;
  const specialtyScore = tax.matched ? 1.0 : 0.0;
  const confidence = 0.35 * identityScore + 0.25 * locationScore + 0.4 * specialtyScore;
  result.confidence = round(confidence, 3);

  // Decision thresholds (mirror Python reference exactly)
  const identityOk = identityScore >= 0.7;
  const locationOk = cityCheck.score >= 0.8 && (stateExact || stateScore >= 0.9);
  const specialtyOk = tax.matched;

  // Threshold reporting MUST mirror the actual gate at `locationOk` above —
  // the operator-facing badges are useless if they disagree with the verified
  // verdict. Code review caught a previous drift where city_ok used
  // compareStringsField's 0.85 internal cutoff and state_ok ignored the
  // 0.9 fuzzy fallback.
  result.checks.decision_thresholds = {
    identity_score: round(identityScore, 3),
    identity_ok: identityOk,
    city_score: round(cityCheck.score, 3),
    city_ok: cityCheck.score >= 0.8,
    state_score: round(stateScore, 3),
    state_ok: stateExact || stateScore >= 0.9,
    specialty_ok: specialtyOk,
  };

  result.verified = identityOk && locationOk && specialtyOk;
  // Three-way honest status: VERIFIED when all gates pass, MISMATCH when
  // we got data but a gate failed. UNAVAILABLE was already set above if
  // we never got a provider record because NPPES was unreachable.
  result.status = result.verified ? "VERIFIED" : "MISMATCH";
  return result;
}

function round(n: number, decimals: number): number {
  const f = Math.pow(10, decimals);
  return Math.round(n * f) / f;
}

// Test-only re-exports so unit tests can hit the internals without going through
// the live HTTP layer. Not intended for production callers.
export const __test = { pickBestSearchResult, providerTaxonomyMatches, compareStringsField, summarizeProvider };

logger.debug({ module: "npi-verify" }, "loaded");
