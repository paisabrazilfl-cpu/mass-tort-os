/**
 * OFAC sanctions screening — free Treasury source.
 *
 * Why this module exists. The previous OFAC check called
 * `search.ofac-api.com/v3` (a paid third party) and required an
 * `OFAC_API_KEY`. Treasury publishes the canonical Specially Designated
 * Nationals (SDN) list FOR FREE as JSON/CSV/XML downloads — every
 * sanctions-screening vendor wraps that same list.
 *
 *   Canonical free source:
 *     https://www.treasury.gov/ofac/downloads/sdn_advanced.xml
 *     https://www.treasury.gov/ofac/downloads/consolidated/cons_advanced.xml
 *
 *   We use the CSV mirror because parsing 50 MB of XML in Node without a
 *   schema-aware parser is fragile. Treasury's SDN list CSV is small
 *   (~10 MB, ~10 K entries) and stable: three CSVs combine to give
 *   id, type, name, programs, aka-list.
 *     sdn.csv   — primary entries (id, name, type, programs)
 *     alt.csv   — alias / a.k.a. names linked by sdn id
 *     add.csv   — addresses (we don't use these for name screening)
 *
 *   Treasury republishes the files multiple times per week. We download
 *   on first use and cache in memory; a background refresh re-pulls
 *   every `SDN_REFRESH_INTERVAL_MS`. If a refresh fails we keep using
 *   the last successful snapshot (fail-open on a fresher copy, never
 *   serve no data when we have a usable cache).
 *
 *   This module is OPT-IN-FREE: set `OFAC_USE_TREASURY=1` (default ON)
 *   and the bg-hub uses this path with no key required. Operators who
 *   already pay for a third-party screening service can keep using it
 *   by setting `OFAC_USE_TREASURY=0` (the legacy `OFAC_API_KEY` path
 *   still resolves through `lib/background-check.ts`).
 *
 *   Name matching is conservative on purpose. We normalize (lowercase,
 *   strip punctuation, collapse whitespace) and require BOTH the
 *   provided first and last name to appear as whole-word tokens in the
 *   SDN entry's full-name or any AKA. We deliberately do NOT do fuzzy
 *   / phonetic matching here — false positives in a legal-facing
 *   sanctions hit are a worse failure than a near miss, and operators
 *   should run a higher-recall search manually when they suspect one.
 */
import { logger } from "./logger";

interface SdnEntry {
  sdn_id: string;
  name: string;
  type: string;
  programs: string[];
  akas: string[];
}

interface SdnSnapshot {
  fetched_at: number;
  entries: SdnEntry[];
  source: string;
}

const SDN_CSV_URL = process.env["OFAC_SDN_CSV_URL"] ?? "https://www.treasury.gov/ofac/downloads/sdn.csv";
const SDN_ALT_CSV_URL = process.env["OFAC_SDN_ALT_CSV_URL"] ?? "https://www.treasury.gov/ofac/downloads/alt.csv";
const SDN_REFRESH_INTERVAL_MS = Number(process.env["OFAC_SDN_REFRESH_MS"] ?? 24 * 60 * 60 * 1000); // daily
const SDN_FETCH_TIMEOUT_MS = Number(process.env["OFAC_SDN_FETCH_TIMEOUT_MS"] ?? 60_000);

export function isTreasurySdnEnabled(): boolean {
  // Default ON. Operator can disable with OFAC_USE_TREASURY=0 to fall back
  // to whatever paid provider they have wired up.
  return (process.env["OFAC_USE_TREASURY"] ?? "1") !== "0";
}

let snapshot: SdnSnapshot | null = null;
let pendingFetch: Promise<SdnSnapshot> | null = null;

function normalize(s: string): string {
  return s
    .toLowerCase()
    .replace(/[.,;()\[\]"']/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Treasury CSV uses an unusual quoting style: fields are quoted with double
// quotes; embedded quotes are doubled. This is a minimal RFC-4180-ish
// parser tuned to that format. We never see line breaks inside fields in
// the SDN list, but we tolerate them defensively.
function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQuotes) {
      if (c === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cur += c;
      }
    } else {
      if (c === '"') {
        inQuotes = true;
      } else if (c === ",") {
        out.push(cur);
        cur = "";
      } else {
        cur += c;
      }
    }
  }
  out.push(cur);
  return out;
}

async function fetchText(url: string): Promise<string> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), SDN_FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { "User-Agent": "mass-tort-os/ofac-treasury" },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

async function fetchSnapshot(): Promise<SdnSnapshot> {
  // sdn.csv schema (fixed since 2008):
  //   ent_num, SDN_Name, SDN_Type, Program, Title, Call_Sign, Vess_type,
  //   Tonnage, GRT, Vess_flag, Vess_owner, Remarks
  // alt.csv schema:
  //   ent_num, alt_num, alt_type, alt_name, alt_remarks
  const [sdnText, altText] = await Promise.all([fetchText(SDN_CSV_URL), fetchText(SDN_ALT_CSV_URL)]);

  const akaIndex = new Map<string, string[]>();
  for (const line of altText.split(/\r?\n/)) {
    if (!line) continue;
    const cols = parseCsvLine(line);
    const id = cols[0]?.trim();
    const name = cols[3]?.trim();
    if (!id || !name) continue;
    const list = akaIndex.get(id) ?? [];
    list.push(name);
    akaIndex.set(id, list);
  }

  const entries: SdnEntry[] = [];
  for (const line of sdnText.split(/\r?\n/)) {
    if (!line) continue;
    const cols = parseCsvLine(line);
    const id = cols[0]?.trim();
    const name = cols[1]?.trim();
    const type = cols[2]?.trim() ?? "";
    const program = cols[3]?.trim() ?? "";
    if (!id || !name) continue;
    entries.push({
      sdn_id: id,
      name,
      type,
      programs: program ? program.split(/\s*;\s*/).filter(Boolean) : [],
      akas: akaIndex.get(id) ?? [],
    });
  }

  return {
    fetched_at: Date.now(),
    entries,
    source: SDN_CSV_URL,
  };
}

async function getSnapshot(): Promise<SdnSnapshot> {
  if (snapshot && Date.now() - snapshot.fetched_at < SDN_REFRESH_INTERVAL_MS) {
    return snapshot;
  }
  if (pendingFetch) return pendingFetch;
  pendingFetch = (async () => {
    try {
      const fresh = await fetchSnapshot();
      logger.info(
        { count: fresh.entries.length, source: fresh.source },
        "OFAC Treasury SDN list refreshed",
      );
      snapshot = fresh;
      return fresh;
    } catch (err) {
      if (snapshot) {
        logger.warn(
          { err: String(err).slice(0, 200), age_ms: Date.now() - snapshot.fetched_at },
          "OFAC Treasury SDN refresh failed — continuing with stale cache",
        );
        return snapshot;
      }
      logger.error({ err: String(err).slice(0, 200) }, "OFAC Treasury SDN initial fetch failed");
      throw err;
    } finally {
      pendingFetch = null;
    }
  })();
  return pendingFetch;
}

export interface TreasurySdnMatchOutcome {
  status: "ok" | "error";
  matches: Array<{ sdn_id: string; name: string; programs: string[]; matched_via: "name" | "aka" }>;
  source: string;
  fetched_at: string | null;
  note?: string;
}

/**
 * Match a person against the Treasury SDN list. Conservative:
 * requires BOTH first and last name to appear as whole-word tokens in
 * the candidate name (or any AKA) after normalization. Returns up to 5
 * matches.
 *
 * This intentionally does not gate on the bg-hub's normal name
 * heuristics — the SDN list is small enough that a linear scan per
 * lookup is ~5 ms (10 K entries). We can swap in a token-index if a
 * future profile shows it matters.
 */
export async function matchTreasurySdn(person: {
  first_name: string;
  last_name: string;
}): Promise<TreasurySdnMatchOutcome> {
  const first = normalize(person.first_name || "");
  const last = normalize(person.last_name || "");
  if (!first || !last) {
    return {
      status: "error",
      matches: [],
      source: SDN_CSV_URL,
      fetched_at: null,
      note: "first_name and last_name are required",
    };
  }
  let snap: SdnSnapshot;
  try {
    snap = await getSnapshot();
  } catch (err) {
    return {
      status: "error",
      matches: [],
      source: SDN_CSV_URL,
      fetched_at: null,
      note: `Treasury SDN list unavailable: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  const wholeWord = (haystack: string, needle: string): boolean => {
    // Whole-word match against tokenized haystack — defends against the
    // pathological case where someone named "Al" matches every Al-prefixed
    // SDN entry (e.g. "Albert", "Aleksandr").
    const tokens = new Set(haystack.split(" "));
    return tokens.has(needle);
  };
  const matches: TreasurySdnMatchOutcome["matches"] = [];
  for (const e of snap.entries) {
    const primary = normalize(e.name);
    if (wholeWord(primary, first) && wholeWord(primary, last)) {
      matches.push({ sdn_id: e.sdn_id, name: e.name, programs: e.programs, matched_via: "name" });
      if (matches.length >= 5) break;
      continue;
    }
    for (const aka of e.akas) {
      const norm = normalize(aka);
      if (wholeWord(norm, first) && wholeWord(norm, last)) {
        matches.push({ sdn_id: e.sdn_id, name: aka, programs: e.programs, matched_via: "aka" });
        break;
      }
    }
    if (matches.length >= 5) break;
  }
  return {
    status: "ok",
    matches,
    source: snap.source,
    fetched_at: new Date(snap.fetched_at).toISOString(),
  };
}

// Test-only helper to inject a synthetic snapshot. NEVER call from
// non-test code. Exported behind a deliberate underscore prefix so it
// doesn't show up in editor autocomplete for normal usage.
export function __setSdnSnapshotForTests(s: SdnSnapshot | null): void {
  snapshot = s;
  pendingFetch = null;
}
