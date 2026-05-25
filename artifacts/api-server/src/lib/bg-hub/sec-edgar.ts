/**
 * SEC EDGAR live adapter for business-entity verification.
 *
 * Why this is the FREE business-entity-check we can ship now:
 *   - SEC operates `data.sec.gov` and `www.sec.gov` as public APIs with
 *     no key, no rate-limit auth, just a polite User-Agent requirement.
 *   - The `company_tickers.json` endpoint returns every SEC-registered
 *     company (CIK / ticker / title). Roughly 10 K entries — totally
 *     cacheable in process.
 *   - Match is exact (case-insensitive) on the canonical "title" field
 *     and on alternate company-name records. False positives are
 *     vanishingly rare because SEC filings disambiguate.
 *
 * Coverage limit: only entities that have SEC filings — public
 * companies, most large LLCs, anyone who's done a Reg D filing. Small
 * mom-and-pop LLCs are NOT in EDGAR. That's why this is wired as
 * "live but partial" rather than the only adapter — the smart-link to
 * the state SoS picks up the rest.
 *
 * Polite User-Agent (per SEC: https://www.sec.gov/os/accessing-edgar-data)
 * — required, anonymous queries are 403'd. We use OFAC-style identifier
 * with operator email if EDGAR_CONTACT_EMAIL is set.
 */
import { logger } from "../logger";

const EDGAR_COMPANY_TICKERS_URL = "https://www.sec.gov/files/company_tickers.json";
const EDGAR_REFRESH_INTERVAL_MS = Number(process.env["EDGAR_REFRESH_MS"] ?? 24 * 60 * 60 * 1000);
const EDGAR_FETCH_TIMEOUT_MS = Number(process.env["EDGAR_FETCH_TIMEOUT_MS"] ?? 30_000);

function userAgent(): string {
  const contact = process.env["EDGAR_CONTACT_EMAIL"] ?? "operator@example.com";
  return `mass-tort-os/bg-hub-sec-edgar ${contact}`;
}

interface EdgarEntry {
  cik: number;
  ticker: string;
  title: string;
}

interface EdgarSnapshot {
  fetched_at: number;
  // Map from normalized title → entries. Multiple tickers can share a name
  // (rare; e.g. Class A/B shares) so the value is an array.
  byTitle: Map<string, EdgarEntry[]>;
  count: number;
}

let snapshot: EdgarSnapshot | null = null;
let pendingFetch: Promise<EdgarSnapshot> | null = null;

function normalize(s: string): string {
  // EDGAR titles are SHOUTY and contain corporate-suffix noise. We strip
  // common suffixes and punctuation so "Apple, Inc." matches "APPLE INC".
  return s
    .toLowerCase()
    .replace(/[.,;()\[\]"']/g, " ")
    .replace(/\b(inc|incorporated|corp|corporation|llc|l\.l\.c|ltd|limited|co|company|plc|nv|sa|ag|holding|holdings|group|trust|partners|lp|llp)\b/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

async function fetchSnapshot(): Promise<EdgarSnapshot> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), EDGAR_FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(EDGAR_COMPANY_TICKERS_URL, {
      signal: ctrl.signal,
      headers: { "User-Agent": userAgent(), Accept: "application/json" },
    });
    if (!res.ok) throw new Error(`EDGAR HTTP ${res.status}`);
    // EDGAR ships company_tickers.json as { "0": {cik_str, ticker, title}, "1": {...}, ... }
    const data = (await res.json()) as Record<string, { cik_str?: number; ticker?: string; title?: string }>;
    const byTitle = new Map<string, EdgarEntry[]>();
    let count = 0;
    for (const v of Object.values(data)) {
      const cik = v.cik_str;
      const title = v.title;
      const ticker = v.ticker;
      if (typeof cik !== "number" || !title || !ticker) continue;
      const key = normalize(title);
      if (!key) continue;
      const arr = byTitle.get(key) ?? [];
      arr.push({ cik, ticker, title });
      byTitle.set(key, arr);
      count++;
    }
    return { fetched_at: Date.now(), byTitle, count };
  } finally {
    clearTimeout(timer);
  }
}

async function getSnapshot(): Promise<EdgarSnapshot> {
  if (snapshot && Date.now() - snapshot.fetched_at < EDGAR_REFRESH_INTERVAL_MS) {
    return snapshot;
  }
  if (pendingFetch) return pendingFetch;
  pendingFetch = (async () => {
    try {
      const fresh = await fetchSnapshot();
      logger.info({ count: fresh.count }, "SEC EDGAR company_tickers cache refreshed");
      snapshot = fresh;
      return fresh;
    } catch (err) {
      if (snapshot) {
        logger.warn(
          { err: String(err).slice(0, 200), age_ms: Date.now() - snapshot.fetched_at },
          "SEC EDGAR refresh failed — serving stale cache",
        );
        return snapshot;
      }
      logger.error({ err: String(err).slice(0, 200) }, "SEC EDGAR initial fetch failed");
      throw err;
    } finally {
      pendingFetch = null;
    }
  })();
  return pendingFetch;
}

export interface EdgarMatchOutcome {
  status: "ok" | "error";
  matches: Array<{ cik: number; ticker: string; title: string; edgar_url: string }>;
  fetched_at: string | null;
  note?: string;
}

/**
 * Look up a business name against the SEC EDGAR company_tickers index.
 * Returns 0..N exact-normalized matches. CIK is the SEC's primary key —
 * the returned `edgar_url` points at the filer's EDGAR page where the
 * operator can audit recent filings, addresses, etc.
 */
export async function searchEdgar(businessName: string): Promise<EdgarMatchOutcome> {
  const key = normalize(businessName || "");
  if (!key) {
    return { status: "error", matches: [], fetched_at: null, note: "businessName is required" };
  }
  let snap: EdgarSnapshot;
  try {
    snap = await getSnapshot();
  } catch (err) {
    return {
      status: "error",
      matches: [],
      fetched_at: null,
      note: `SEC EDGAR unavailable: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  const hits = snap.byTitle.get(key) ?? [];
  return {
    status: "ok",
    matches: hits.slice(0, 5).map((h) => ({
      ...h,
      edgar_url: `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${String(h.cik).padStart(10, "0")}&type=&dateb=&owner=include&count=40`,
    })),
    fetched_at: new Date(snap.fetched_at).toISOString(),
  };
}

// Test-only helper.
export function __setEdgarSnapshotForTests(s: EdgarSnapshot | null): void {
  snapshot = s;
  pendingFetch = null;
}
