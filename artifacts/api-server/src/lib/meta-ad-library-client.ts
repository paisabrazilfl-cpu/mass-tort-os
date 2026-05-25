/**
 * Meta (Facebook) Ad Library API client.
 *
 * Searches the public Ad Library at graph.facebook.com/v21.0/ads_archive.
 * Requires a Meta user access token stored in the integrations vault under
 * provider "meta_ad_library" with a field called "access_token".
 *
 * No app review is required for basic access when using a standard user
 * token with ads_read permission.
 *
 * Docs: https://developers.facebook.com/docs/marketing-api/reference/ads-archive
 */

import { logger } from "./logger";

const META_GRAPH_BASE = "https://graph.facebook.com/v21.0";
const DEFAULT_TIMEOUT_MS = 20_000;

export class MetaAdLibraryError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code?: string | number,
    public readonly body?: unknown,
  ) {
    super(message);
    this.name = "MetaAdLibraryError";
  }
}

export interface MetaAd {
  id?: string;
  page_id?: string;
  page_name?: string;
  ad_creative_bodies?: string[];
  ad_creative_link_titles?: string[];
  ad_snapshot_url?: string;
  bylines?: string[];
  publisher_platforms?: string[];
  ad_delivery_start_time?: string;
  ad_delivery_stop_time?: string;
}

export interface MetaAdLibraryResponse {
  /** Normalised by the client — callers always use `ads`. */
  ads: MetaAd[];
  paging?: {
    cursors?: { before?: string; after?: string };
    next?: string;
  };
  error?: {
    message?: string;
    type?: string;
    code?: number;
    fbtrace_id?: string;
  };
}

/** Raw shape returned by graph.facebook.com — `data` is the ad array. */
interface MetaGraphRawResponse {
  data?: MetaAd[];
  paging?: MetaAdLibraryResponse["paging"];
  error?: MetaAdLibraryResponse["error"];
}

function getAccessToken(): string {
  const token = process.env["META_AD_LIBRARY_TOKEN"];
  if (!token) {
    throw new MetaAdLibraryError(
      "META_AD_LIBRARY_TOKEN is not configured. Add it in Secrets to enable Meta Ad Library lookups.",
      503,
    );
  }
  return token;
}

export function isMetaAdLibraryConfigured(): boolean {
  return !!process.env["META_AD_LIBRARY_TOKEN"];
}

const AD_FIELDS = [
  "id",
  "page_id",
  "page_name",
  "ad_creative_bodies",
  "ad_creative_link_titles",
  "ad_snapshot_url",
  "bylines",
  "publisher_platforms",
  "ad_delivery_start_time",
  "ad_delivery_stop_time",
].join(",");

/**
 * Search the Meta Ad Library for ads by a firm name (search_terms).
 * Returns up to 25 ads (one page). Pass the firm's Facebook Page name or
 * common trade name for the best results.
 */
export async function metaSearchAds(
  searchTerms: string,
  options: { limit?: number; countries?: string[] } = {},
): Promise<MetaAdLibraryResponse> {
  const q = String(searchTerms || "").trim();
  if (!q) throw new MetaAdLibraryError("searchTerms is required", 400);

  const token = getAccessToken();
  const url = new URL(`${META_GRAPH_BASE}/ads_archive`);
  url.searchParams.set("search_terms", q);
  url.searchParams.set("ad_reached_countries", JSON.stringify(options.countries ?? ["US"]));
  url.searchParams.set("ad_type", "ALL");
  url.searchParams.set("ad_active_status", "ALL");
  url.searchParams.set("fields", AD_FIELDS);
  url.searchParams.set("limit", String(Math.min(options.limit ?? 25, 50)));
  url.searchParams.set("access_token", token);

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), DEFAULT_TIMEOUT_MS);
  try {
    const res = await fetch(url.toString(), { signal: ctrl.signal });
    const text = await res.text();
    let body: unknown;
    try { body = JSON.parse(text); } catch { body = text; }

    if (!res.ok) {
      const safeUrl = url.toString().replace(/access_token=[^&]+/, "access_token=***");
      logger.warn({ url: safeUrl, status: res.status }, "meta ad library error");
      const apiErr = (body as { error?: { message?: string; code?: number } } | undefined)?.error;
      throw new MetaAdLibraryError(
        apiErr?.message ?? `Meta API ${res.status}`,
        res.status,
        apiErr?.code,
        body,
      );
    }

    const typed = body as MetaGraphRawResponse;
    // Graph API errors can land inside a 200 body
    if (typed?.error) {
      throw new MetaAdLibraryError(
        typed.error.message ?? "Meta API error",
        400,
        typed.error.code,
        body,
      );
    }

    return { ads: typed?.data ?? [], paging: typed?.paging };
  } catch (err) {
    if (err instanceof MetaAdLibraryError) throw err;
    if ((err as { name?: string }).name === "AbortError") {
      throw new MetaAdLibraryError(`Meta Ad Library timeout after ${DEFAULT_TIMEOUT_MS}ms`, 504);
    }
    throw new MetaAdLibraryError(`Meta Ad Library network error: ${(err as Error).message}`, 502);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Search Meta Ad Library by a Facebook Page ID for pinpoint accuracy
 * when the firm's page ID is known.
 */
export async function metaSearchAdsByPageId(
  pageId: string,
  options: { limit?: number; countries?: string[] } = {},
): Promise<MetaAdLibraryResponse> {
  const id = String(pageId || "").trim();
  if (!id) throw new MetaAdLibraryError("pageId is required", 400);

  const token = getAccessToken();
  const url = new URL(`${META_GRAPH_BASE}/ads_archive`);
  url.searchParams.set("search_page_ids", id);
  url.searchParams.set("ad_reached_countries", JSON.stringify(options.countries ?? ["US"]));
  url.searchParams.set("ad_type", "ALL");
  url.searchParams.set("ad_active_status", "ALL");
  url.searchParams.set("fields", AD_FIELDS);
  url.searchParams.set("limit", String(Math.min(options.limit ?? 25, 50)));
  url.searchParams.set("access_token", token);

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), DEFAULT_TIMEOUT_MS);
  try {
    const res = await fetch(url.toString(), { signal: ctrl.signal });
    const text = await res.text();
    let body: unknown;
    try { body = JSON.parse(text); } catch { body = text; }

    if (!res.ok) {
      const apiErr = (body as { error?: { message?: string; code?: number } } | undefined)?.error;
      throw new MetaAdLibraryError(
        apiErr?.message ?? `Meta API ${res.status}`,
        res.status,
        apiErr?.code,
        body,
      );
    }

    const typed = body as MetaGraphRawResponse;
    if (typed?.error) {
      throw new MetaAdLibraryError(typed.error.message ?? "Meta API error", 400, typed.error.code, body);
    }

    return { ads: typed?.data ?? [], paging: typed?.paging };
  } catch (err) {
    if (err instanceof MetaAdLibraryError) throw err;
    if ((err as { name?: string }).name === "AbortError") {
      throw new MetaAdLibraryError(`Meta Ad Library timeout after ${DEFAULT_TIMEOUT_MS}ms`, 504);
    }
    throw new MetaAdLibraryError(`Meta Ad Library network error: ${(err as Error).message}`, 502);
  } finally {
    clearTimeout(timer);
  }
}
