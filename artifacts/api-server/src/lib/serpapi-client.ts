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

function getApiKey(): string {
  const key = process.env["SERPAPI_API_KEY"];
  if (!key) {
    throw new SerpapiError(
      "SERPAPI_API_KEY is not configured. Add it in Secrets to enable Competitive Intelligence.",
      503,
    );
  }
  return key;
}

export function isSerpapiConfigured(): boolean {
  return !!process.env["SERPAPI_API_KEY"];
}

async function serpapiFetch<T>(params: Record<string, string>, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<T> {
  const url = new URL(SERPAPI_BASE);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  url.searchParams.set("api_key", getApiKey());

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
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
    // SerpAPI returns 200 with `error` field for two distinct cases:
    //   a) "No results" — the advertiser exists but has no active ads, or the
    //      name search matched nothing. Treat as empty payload, not an error.
    //   b) Real logical errors (invalid advertiser id format, bad params, etc.)
    //      — throw so the caller surfaces a useful message.
    if (typeof body === "object" && body && "error" in body) {
      const msg = (body as { error?: string }).error ?? "";
      const isNoResults =
        /hasn't returned any results/i.test(msg) ||
        /no results/i.test(msg) ||
        /no ads/i.test(msg);
      if (!isNoResults) {
        throw new SerpapiError(msg, 422, body);
      }
      // "No results" — return body as-is so callers get empty ad_creatives /
      // advertisers arrays rather than an exception.
    }
    return body as T;
  } catch (err) {
    if (err instanceof SerpapiError) throw err;
    if ((err as { name?: string }).name === "AbortError") {
      throw new SerpapiError(`SerpAPI timeout after ${timeoutMs}ms`, 504);
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
export async function serpapiAdvertiserAds(advertiserId: string): Promise<SerpapiAdvertiserAdsResponse> {
  const id = String(advertiserId || "").trim();
  if (!id) throw new SerpapiError("advertiserId is required", 400);
  return serpapiFetch<SerpapiAdvertiserAdsResponse>({
    engine: "google_ads_transparency_center",
    advertiser_id: id,
  });
}

/**
 * Search the Transparency Center for advertisers by name.
 * Returns a small list the operator can pick from to add to their
 * watchlist by id.
 */
export async function serpapiSearchAdvertisers(query: string): Promise<SerpapiAdvertiserSearchResponse> {
  const q = String(query || "").trim();
  if (!q) throw new SerpapiError("query is required", 400);
  return serpapiFetch<SerpapiAdvertiserSearchResponse>({
    engine: "google_ads_transparency_center",
    text: q,
  });
}
