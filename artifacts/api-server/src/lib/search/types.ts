/**
 * Common interface every web-search adapter must implement.
 *
 * Adapters wrap a search-engine API (SerpAPI, Tavily, Brave, etc.) and
 * return a normalized list of organic results so workflow nodes don't
 * have to care which provider answered. They never throw on expected
 * provider errors — they return a structured `SearchError` so callers
 * can decide whether to retry, fall back, or surface the error.
 */
import type { DecryptedCredentials } from "../../routes/integrations";

export interface SearchRequest {
  query: string;
  /** Engine hint, e.g. "google" | "bing" | "yahoo". Adapter-specific. */
  engine?: string;
  /** Optional location/geo string passed through to the provider. */
  location?: string;
  /** Maximum results to return. Adapters cap to provider-allowed values. */
  num?: number;
}

export interface SearchResultItem {
  title: string;
  link: string;
  snippet: string;
  position?: number;
  source?: string;
}

export interface SearchResultOk {
  ok: true;
  provider: string;
  engine: string;
  query: string;
  results: SearchResultItem[];
  /** Raw provider payload for debugging — kept compact by adapters. */
  raw?: unknown;
}

export interface SearchError {
  ok: false;
  retryable: boolean;
  code: string;
  message: string;
}

export type SearchOutcome = SearchResultOk | SearchError;

export interface SearchAdapter {
  provider: string;
  /** Default engine when the request omits one (e.g. "google"). */
  defaultEngine: string;
  search(creds: DecryptedCredentials | null, req: SearchRequest): Promise<SearchOutcome>;
}
