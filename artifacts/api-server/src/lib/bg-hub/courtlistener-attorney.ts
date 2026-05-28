/**
 * CourtListener attorney-of-record adapter for the bg-hub attorney lane.
 *
 * Strategy: search the public RECAP index (type=r) for the lead's name
 * appearing in the `attorney` field — counsel-of-record metadata that
 * CourtListener extracts from every PACER docket entry. If the claimant
 * appears as a licensed attorney in federal cases, the operator reviews
 * whether there's a conflict-of-interest or intelligence-gathering risk.
 *
 * Auth:
 *   - Public RECAP search (/search/?type=r) works WITHOUT a token.
 *   - Adding a vault-stored CourtListener API token (Settings → Integrations,
 *     provider="courtlistener") elevates the rate-limit tier AND unlocks the
 *     dedicated /api/rest/v4/attorneys/ name-lookup endpoint.
 *
 * Honesty contract (never invents a PASS):
 *   - "not_found" → no federal attorney appearances for this name, but state
 *     bar membership is NOT checked → adapter returns "not_found" and the
 *     hub emits `attorney_search_ran_no_hits` (REVIEW_REQUIRED, not PASS).
 *   - "ok" with hits → `possible_attorney_hit` (REVIEW_REQUIRED).
 *   - "source_unavailable" → `attorney_check_source_unavailable` (REVIEW_REQUIRED).
 */

import { logger } from "../logger";
import { getIntegrationCredentials } from "../../routes/integrations";

const CL_BASE = "https://www.courtlistener.com/api/rest/v4";
const CL_TIMEOUT_MS = Number(process.env["CL_ATTORNEY_TIMEOUT_MS"] ?? 12_000);

export interface ClAttorneyHit {
  case_name: string;
  docket_number: string;
  court: string;
  date_filed: string | null;
  attorney_name: string;
  firm: string | null;
  docket_url: string;
}

export type ClAttorneyResult =
  | { status: "ok"; hits: ClAttorneyHit[]; search_name: string; checked_at: string }
  | { status: "not_found"; search_name: string; checked_at: string }
  | { status: "source_unavailable"; note: string };

async function resolveClToken(firmId?: number): Promise<string | null> {
  try {
    const creds = await getIntegrationCredentials("courtlistener", firmId);
    const token =
      (creds && typeof creds.api_key === "string" && creds.api_key) ||
      process.env["COURTLISTENER_API_TOKEN"] ||
      "";
    return token || null;
  } catch {
    return process.env["COURTLISTENER_API_TOKEN"] || null;
  }
}

function headers(token: string | null): Record<string, string> {
  const h: Record<string, string> = {
    "User-Agent": "mass-tort-os/bg-hub-attorney",
    Accept: "application/json",
  };
  if (token) h["Authorization"] = `Token ${token}`;
  return h;
}

/**
 * Public RECAP search — works without any auth token.
 * Searches for the person's full name in the `attorney` field of docket entries.
 */
async function searchRecapAttorney(
  firstName: string,
  lastName: string,
  token: string | null,
): Promise<ClAttorneyResult> {
  const fullName = `${firstName} ${lastName}`;
  const q = encodeURIComponent(`"${firstName} ${lastName}"`);
  const url = `${CL_BASE}/search/?q=${q}&type=r&format=json&page_size=10`;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), CL_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: headers(token) });
    if (!res.ok) {
      return {
        status: "source_unavailable",
        note: `CourtListener RECAP search HTTP ${res.status}`,
      };
    }
    const data = (await res.json()) as {
      results?: Array<{
        caseName?: string;
        docketNumber?: string;
        court?: string;
        dateFiled?: string;
        attorney?: string[];
        firm?: string[];
        docket_absolute_url?: string;
        docket_id?: number;
      }>;
    };

    const results = data.results ?? [];
    const fnLow = firstName.toLowerCase();
    const lnLow = lastName.toLowerCase();
    const hits: ClAttorneyHit[] = [];
    const seen = new Set<string>();

    for (const r of results) {
      const attorneys = r.attorney ?? [];
      const firms = r.firm ?? [];
      for (let i = 0; i < attorneys.length; i++) {
        const atty = attorneys[i] ?? "";
        const attyLow = atty.toLowerCase();
        if (!attyLow.includes(fnLow) || !attyLow.includes(lnLow)) continue;
        const key = `${r.caseName ?? ""}|${r.docketNumber ?? ""}`;
        if (seen.has(key)) continue;
        seen.add(key);
        hits.push({
          case_name: r.caseName ?? "Unknown",
          docket_number: r.docketNumber ?? "",
          court: r.court ?? "",
          date_filed: r.dateFiled ?? null,
          attorney_name: atty,
          firm: firms[i] ?? null,
          docket_url: r.docket_absolute_url
            ? `https://www.courtlistener.com${r.docket_absolute_url}`
            : r.docket_id
              ? `https://www.courtlistener.com/docket/${r.docket_id}/`
              : "https://www.courtlistener.com/",
        });
      }
    }

    if (hits.length === 0) {
      return { status: "not_found", search_name: fullName, checked_at: new Date().toISOString() };
    }
    return {
      status: "ok",
      hits: hits.slice(0, 5),
      search_name: fullName,
      checked_at: new Date().toISOString(),
    };
  } catch (err) {
    if ((err as { name?: string }).name === "AbortError") {
      return {
        status: "source_unavailable",
        note: `CourtListener RECAP search timed out after ${CL_TIMEOUT_MS}ms`,
      };
    }
    logger.warn({ err }, "bg-hub: CourtListener RECAP attorney search failed");
    return {
      status: "source_unavailable",
      note: `CourtListener RECAP network error: ${err instanceof Error ? err.message : String(err)}`,
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Authenticated /api/rest/v4/attorneys/ endpoint — higher fidelity, better
 * rate limits. Only called when a vault token is present. Returns null to
 * signal the caller should fall back to the RECAP search.
 */
async function searchAttorneyEndpoint(
  firstName: string,
  lastName: string,
  token: string,
): Promise<ClAttorneyResult | null> {
  const fullName = `${firstName} ${lastName}`;
  const url = `${CL_BASE}/attorneys/?name=${encodeURIComponent(fullName)}&format=json&page_size=5`;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), CL_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: headers(token) });
    if (res.status === 401 || res.status === 403) {
      logger.warn(
        { status: res.status },
        "bg-hub: CL /attorneys/ auth rejected — falling back to RECAP search",
      );
      return null;
    }
    if (!res.ok) {
      return {
        status: "source_unavailable",
        note: `CourtListener /attorneys/ HTTP ${res.status}`,
      };
    }
    const data = (await res.json()) as {
      count?: number;
      results?: Array<{
        id?: number;
        name?: string;
        roles?: Array<{
          docket?: {
            absolute_url?: string;
            case_name?: string;
            court?: string;
            date_filed?: string;
            docket_number?: string;
          };
          role?: string;
        }>;
      }>;
    };

    const results = data.results ?? [];
    if (results.length === 0) {
      return {
        status: "not_found",
        search_name: fullName,
        checked_at: new Date().toISOString(),
      };
    }

    const hits: ClAttorneyHit[] = [];
    for (const atty of results.slice(0, 3)) {
      for (const role of (atty.roles ?? []).slice(0, 3)) {
        const dk = role.docket;
        if (!dk) continue;
        hits.push({
          case_name: dk.case_name ?? "Unknown",
          docket_number: dk.docket_number ?? "",
          court: dk.court ?? "",
          date_filed: dk.date_filed ?? null,
          attorney_name: atty.name ?? fullName,
          firm: null,
          docket_url: dk.absolute_url
            ? `https://www.courtlistener.com${dk.absolute_url}`
            : "https://www.courtlistener.com/",
        });
      }
    }
    if (hits.length === 0) {
      return {
        status: "not_found",
        search_name: fullName,
        checked_at: new Date().toISOString(),
      };
    }
    return {
      status: "ok",
      hits: hits.slice(0, 5),
      search_name: fullName,
      checked_at: new Date().toISOString(),
    };
  } catch (err) {
    if ((err as { name?: string }).name === "AbortError") {
      return null; // timeout — fall back to RECAP search
    }
    logger.warn({ err }, "bg-hub: CL /attorneys/ endpoint error — falling back to RECAP search");
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Primary export. Tries the authenticated /attorneys/ endpoint when a token
 * is configured, falls back to the public RECAP search otherwise.
 */
export async function searchClAttorney(
  firstName: string,
  lastName: string,
  firmId?: number,
): Promise<ClAttorneyResult> {
  const token = await resolveClToken(firmId);

  if (token) {
    const tokenResult = await searchAttorneyEndpoint(firstName, lastName, token);
    if (tokenResult !== null) return tokenResult;
  }

  return searchRecapAttorney(firstName, lastName, token);
}
