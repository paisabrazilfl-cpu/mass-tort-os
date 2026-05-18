/**
 * Thin client for SerpAPI's Google Ads Transparency Center engine
 * (https://serpapi.com/google-ads-transparency-center).
 *
 * Powers the Competitive Intelligence feature: a mass-tort firm can
 * look up an opposing firm's advertiser id (e.g. Morgan & Morgan) and
 * see what tort campaigns they're currently advertising — a useful
 * leading indicator for new MDLs.
 *
 * Auth: `api_key` query parameter. We never log the key. SerpAPI
 * mirrors Google's results so the firm doesn't need a Google account.
 */
import { logger } from "./logger";

const SERPAPI_BASE = process.env["SERPAPI_BASE_URL"] || "https://serpapi.com/search.json";
const DEFAULT_TIMEOUT_MS = 20_000;

export class SerpapiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly body?: unknown,
  ) {
    super(message);
    this.name = "SerpapiError";
  }
}

export interface SerpapiAdCreative {
  ad_creative_id?: string;
  format?: string;
  image?: string;
  video?: string;
  text?: string;
  destination_url?: string;
  first_shown?: string;
  last_shown?: string;
  days_shown?: number;
  regions?: string[];
}

export interface SerpapiAdvertiserAdsResponse {
  advertiser?: { id?: string; name?: string; verified?: boolean; legal_name?: string };
  ad_creatives?: SerpapiAdCreative[];
  search_metadata?: { status?: string };
  error?: string;
}

export interface SerpapiAdvertiserSearchHit {
  advertiser_id: string;
  name?: string;
  legal_name?: string;
  verified?: boolean;
}

export interface SerpapiAdvertiserSearchResponse {
  advertisers?: SerpapiAdvertiserSearchHit[];
  search_metadata?: { status?: string };
  error?: string;
}

/**
 * Resolve the SerpAPI key. Vault-first (per-firm integration row),
 * env-fallback. Returns null if neither path has a key — caller turns
 * that into a 503 via `isSerpapiConfigured()`.
 *
 * Firm scope: when `firmId` is provided we only consider the vault row
 * stamped with that firm_id. The route layer in admin-competitive-intel.ts
 * passes `requireFirmId(req)` so cross-tenant key leakage is impossible.
 * When `firmId` is omitted (e.g. a system-level caller before firm
 * context exists) we skip the vault and use env only.
 */
async function resolveApiKey(firmId?: number): Promise<string | null> {
  if (firmId !== undefined) {
    // Lazy import to avoid a circular dependency between serpapi-client
    // and routes/integrations (integrations route imports the client
    // indirectly via provider-router).
    const { getIntegrationCredentials } = await import("../routes/integrations");
    const creds = await getIntegrationCredentials("serpapi", firmId);
    if (creds?.api_key) return creds.api_key;
  }
  return process.env["SERPAPI_API_KEY"] ?? null;
}

class _SerpapiNotConfigured extends SerpapiError {
  constructor() {
    super(
      "SerpAPI is not configured. Add it in the Integrations Hub (or set the SERPAPI_API_KEY env var as a fallback).",
      503,
    );
  }
}

export async function isSerpapiConfigured(firmId?: number): Promise<boolean> {
  return (await resolveApiKey(firmId)) !== null;
}

async function serpapiFetch<T>(params: Record<string, string>, opts?: { firmId?: number; timeoutMs?: number }): Promise<T> {
  const key = await resolveApiKey(opts?.firmId);
  if (!key) throw new _SerpapiNotConfigured();

  const url = new URL(SERPAPI_BASE);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  url.searchParams.set("api_key", key);

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  try {
    const res = await fetch(url.toString(), { signal: ctrl.signal });
    const text = await res.text();
    let body: unknown = undefined;
    if (text) {
      try { body = JSON.parse(text); } catch { body = text; }
    }
    if (!res.ok) {
      // Strip api_key from URL before logging.
      const safeUrl = url.toString().replace(/api_key=[^&]+/, "api_key=***");
      logger.warn({ url: safeUrl, status: res.status }, "serpapi error");
      const msg =
        (typeof body === "object" && body && "error" in body && (body as { error?: string }).error) ||
        `SerpAPI ${res.status}`;
      throw new SerpapiError(msg as string, res.status, body);
    }
    // SerpAPI returns 200 with `error` field on logical errors (bad advertiser id, etc).
    if (typeof body === "object" && body && "error" in body && (body as { error?: string }).error) {
      throw new SerpapiError((body as { error: string }).error, 422, body);
    }
    return body as T;
  } catch (err) {
    if (err instanceof SerpapiError) throw err;
    if ((err as { name?: string }).name === "AbortError") {
      throw new SerpapiError(`SerpAPI timeout after ${opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS}ms`, 504);
    }
    throw new SerpapiError(`SerpAPI network error: ${(err as Error).message}`, 502);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Look up the active ad creatives for a Google Ads Transparency
 * advertiser id. Advertiser ids look like `AR12345...`.
 */
export async function serpapiAdvertiserAds(advertiserId: string, firmId?: number): Promise<SerpapiAdvertiserAdsResponse> {
  const id = String(advertiserId || "").trim();
  if (!id) throw new SerpapiError("advertiserId is required", 400);
  return serpapiFetch<SerpapiAdvertiserAdsResponse>({
    engine: "google_ads_transparency_center",
    advertiser_id: id,
  }, { firmId });
}

/**
 * Search the Transparency Center for advertisers by name.
 * Returns a small list the operator can pick from to add to their
 * watchlist by id. firm_id resolves the SerpAPI key from the vault.
 */
export async function serpapiSearchAdvertisers(query: string, firmId?: number): Promise<SerpapiAdvertiserSearchResponse> {
  const q = String(query || "").trim();
  if (!q) throw new SerpapiError("query is required", 400);
  return serpapiFetch<SerpapiAdvertiserSearchResponse>({
    engine: "google_ads_transparency_center",
    text: q,
  }, { firmId });
}
