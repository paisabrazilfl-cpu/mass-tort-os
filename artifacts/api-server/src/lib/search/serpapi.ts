import type { SearchAdapter, SearchOutcome, SearchResultItem } from "./types";
import { logger } from "../logger";

/**
 * SerpAPI adapter — calls https://serpapi.com/search.json with the
 * operator's vault api_key. Maps the `organic_results` block onto our
 * normalized SearchResultItem shape. Returns structured errors instead
 * of throwing so workflow runs can record the failure and continue.
 */
const SERPAPI_BASE = "https://serpapi.com/search.json";

export const serpapiAdapter: SearchAdapter = {
  provider: "serpapi",
  defaultEngine: "google",

  async search(creds, req): Promise<SearchOutcome> {
    const apiKey = creds?.api_key?.toString().trim();
    if (!apiKey) {
      return {
        ok: false,
        retryable: false,
        code: "MISSING_CREDENTIALS",
        message: "SerpAPI integration is missing api_key.",
      };
    }
    const query = req.query?.trim();
    if (!query) {
      return {
        ok: false,
        retryable: false,
        code: "BAD_REQUEST",
        message: "SerpAPI search requires a non-empty query.",
      };
    }
    const engine = (req.engine || serpapiAdapter.defaultEngine).trim();
    const num = Math.min(Math.max(Number(req.num) || 10, 1), 100);

    const url = new URL(SERPAPI_BASE);
    url.searchParams.set("engine", engine);
    url.searchParams.set("q", query);
    url.searchParams.set("num", String(num));
    url.searchParams.set("api_key", apiKey);
    if (req.location) url.searchParams.set("location", req.location);

    try {
      const resp = await fetch(url.toString(), {
        method: "GET",
        headers: { Accept: "application/json" },
      });
      const json: any = await resp.json().catch(() => ({}));
      if (!resp.ok) {
        const message = String(json?.error ?? `HTTP ${resp.status}`);
        return {
          ok: false,
          retryable: resp.status === 429 || resp.status >= 500,
          code: `http_${resp.status}`,
          message,
        };
      }
      if (typeof json?.error === "string" && json.error.trim()) {
        // SerpAPI returns HTTP 200 with `error` for things like invalid
        // engine, expired key, plan exhausted. Surface as non-retryable.
        return {
          ok: false,
          retryable: false,
          code: "provider_error",
          message: json.error,
        };
      }
      const organic: any[] = Array.isArray(json?.organic_results) ? json.organic_results : [];
      const results: SearchResultItem[] = organic.slice(0, num).map((r, i) => ({
        title: String(r?.title ?? "").trim(),
        link: String(r?.link ?? r?.url ?? "").trim(),
        snippet: String(r?.snippet ?? r?.description ?? "").trim(),
        position: typeof r?.position === "number" ? r.position : i + 1,
        source: typeof r?.source === "string" ? r.source : undefined,
      }));
      return {
        ok: true,
        provider: "serpapi",
        engine,
        query,
        results,
        raw: { search_metadata: json?.search_metadata, total: organic.length },
      };
    } catch (err: unknown) {
      logger.error({ err, provider: "serpapi" }, "serpapi search failed");
      return {
        ok: false,
        retryable: true,
        code: "network_error",
        message: err instanceof Error ? err.message : String(err),
      };
    }
  },
};
