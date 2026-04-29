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
import { normalize, similarity } from "./string-similarity";

const NPI_API_BASE = "https://npiregistry.cms.hhs.gov/api/";
const NPI_VERSION = "2.1";
const HTTP_TIMEOUT_MS = 10_000;

interface NpiAddress {
  address_purpose?: string;
  address_1?: string;
  address_2?: string;
  city?: string;
  state?: string;
  postal_code?: string;
  telephone_number?: string;
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
}

export interface VerifyProviderResult {
  method: "npi" | "name_search" | null;
  provider: ProviderSummary | null;
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

async function fetchNpi(params: URLSearchParams): Promise<NpiRegistryResult[]> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);
  try {
    const url = `${NPI_API_BASE}?${params.toString()}`;
    const r = await fetch(url, { signal: controller.signal });
    if (!r.ok) {
      throw new Error(`NPI registry returned ${r.status}`);
    }
    const data = (await r.json()) as { results?: NpiRegistryResult[] };
    return data.results ?? [];
  } finally {
    clearTimeout(timeout);
  }
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
  const expName = expected.name ?? "";
  const expOrg = expected.organization ?? "";
  const expCity = expected.city ?? "";
  const expState = expected.state ?? "";

  for (const r of results) {
    const basic = r.basic ?? {};
    const name =
      basic.name ??
      [basic.first_name, basic.last_name].filter(Boolean).join(" ").trim();
    const org = basic.organization_name ?? "";
    const primaryAddr = (r.addresses ?? [])[0] ?? {};
    const nameScore = Math.max(similarity(expName, name), similarity(expName, org));
    const orgScore = similarity(expOrg, org);
    const cityScore = similarity(expCity, primaryAddr.city ?? "");
    const stateScore =
      normalize(expState) === normalize(primaryAddr.state ?? "")
        ? 1.0
        : similarity(expState, primaryAddr.state ?? "");
    // Same weighting as the Python reference: name/org max 0.5, city 0.25, state 0.25
    const score = 0.5 * Math.max(nameScore, orgScore) + 0.25 * cityScore + 0.25 * stateScore;
    if (score > bestScore) {
      bestScore = score;
      best = r;
    }
  }

  return best ? { best, score: bestScore } : null;
}

function providerTaxonomyMatches(
  provider: NpiRegistryResult,
  expectedSpecialty: string,
): { matched: boolean; matched_taxonomies: Array<{ code: string; desc: string; primary: boolean }>; all_descs: string[] } {
  const expected = normalize(expectedSpecialty);
  const taxonomies = provider.taxonomies ?? [];
  const matchedTaxonomies: Array<{ code: string; desc: string; primary: boolean }> = [];
  for (const t of taxonomies) {
    const desc = t.desc ?? "";
    if (!desc) continue;
    if (expected && normalize(desc).includes(expected)) {
      matchedTaxonomies.push({ code: t.code ?? "", desc, primary: !!t.primary });
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
): { match: boolean; score: number } {
  if (!expectedValue) return { match: true, score: 1.0 };
  const score = similarity(providerValue ?? "", expectedValue);
  return { match: score >= threshold, score };
}

function summarizeProvider(p: NpiRegistryResult): ProviderSummary {
  const basic = p.basic ?? {};
  const addresses = p.addresses ?? [];
  const primary = addresses[0] ?? {};
  return {
    npi: String(p.number ?? ""),
    name:
      basic.name ??
      [basic.first_name, basic.last_name].filter(Boolean).join(" ").trim(),
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
    checks: {},
    verified: false,
    confidence: 0,
  };

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
      result.checks.search = { found: false, error: (err as Error).message };
    }
  }

  if (!provider) {
    return result;
  }

  result.provider = summarizeProvider(provider);

  // Per-field scoring against the resolved provider
  const provName = result.provider.name || result.provider.organization_name;
  const nameCheck = compareStringsField(provName, expected.name, 0.75);
  result.checks.name = {
    expected: expected.name ?? "",
    provider: provName,
    score: round(nameCheck.score, 3),
    match: nameCheck.match,
  };

  const provOrg = result.provider.organization_name;
  const orgCheck = compareStringsField(provOrg, expected.organization, 0.7);
  result.checks.organization = {
    expected: expected.organization ?? "",
    provider: provOrg,
    score: round(orgCheck.score, 3),
    match: orgCheck.match,
  };

  const provCity = result.provider.address.city;
  const provState = result.provider.address.state;
  const cityCheck = compareStringsField(provCity, expected.city, 0.85);
  const stateExact = normalize(provState) === normalize(expected.state ?? "");
  const stateScore = stateExact ? 1.0 : similarity(provState, expected.state ?? "");
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
