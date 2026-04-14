import { logger } from "./logger";

export interface BackgroundCheckResult {
  status: "clean" | "flagged" | "not_found" | "error";
  source: string;
  checked_at: string;
  records: BackgroundRecord[];
  summary: string;
}

export interface BackgroundRecord {
  type: string;
  description: string;
  date?: string;
  jurisdiction?: string;
  severity: "low" | "medium" | "high";
}

export async function runBackgroundCheck(person: {
  first_name: string;
  last_name: string;
  state?: string;
  date_of_birth?: string;
}): Promise<BackgroundCheckResult> {
  const checkedAt = new Date().toISOString();
  const fullName = `${person.first_name} ${person.last_name}`;

  try {
    const results: BackgroundRecord[] = [];

    let sourcesReached = 0;

    const courtRecords = await searchCourtRecords(person);
    if (courtRecords !== null) {
      sourcesReached++;
      results.push(...courtRecords);
    }

    const ofacResult = await checkOFACList(person);
    if (ofacResult !== null) {
      sourcesReached++;
      results.push(...ofacResult);
    }

    if (sourcesReached === 0) {
      return {
        status: "error",
        source: "MTOS Background Check (Court Records + OFAC)",
        checked_at: checkedAt,
        records: [],
        summary: `All background check sources unreachable for ${fullName}`,
      };
    }

    const status = results.length === 0 ? "clean" : "flagged";
    const summary = results.length === 0
      ? `No records found for ${fullName}`
      : `${results.length} record(s) found for ${fullName}`;

    return {
      status,
      source: "MTOS Background Check (Court Records + OFAC)",
      checked_at: checkedAt,
      records: results,
      summary,
    };
  } catch (err) {
    logger.error({ err, person: fullName }, "Background check failed");
    return {
      status: "error",
      source: "MTOS Background Check",
      checked_at: checkedAt,
      records: [],
      summary: `Background check error for ${fullName}: ${err instanceof Error ? err.message : "Unknown error"}`,
    };
  }
}

function textContainsName(
  text: string,
  firstName: string,
  lastName: string,
): "exact" | "initial" | false {
  const t = text.toLowerCase();
  const fn = firstName.toLowerCase();
  const ln = lastName.toLowerCase();

  if (t.includes(`${fn} ${ln}`) || t.includes(`${ln}, ${fn}`) || t.includes(`${ln} ${fn}`)) {
    return "exact";
  }

  const fnInitial = fn.charAt(0);
  if (
    t.includes(`${ln}, ${fnInitial}.`) ||
    t.includes(`${ln}, ${fnInitial} `) ||
    t.includes(`${fnInitial}. ${ln}`)
  ) {
    return "initial";
  }

  return false;
}

interface CourtResult {
  caseName?: string;
  dateFiled?: string;
  court?: string;
  docketNumber?: string;
  party?: string[];
  recap_documents?: Array<{
    description?: string;
    snippet?: string;
  }>;
}

function nameMatchesResult(
  result: CourtResult,
  firstName: string,
  lastName: string,
): { match: boolean; confidence: "exact" | "strong" | "none" } {
  const caseName = result.caseName || "";
  const caseMatch = textContainsName(caseName, firstName, lastName);
  if (caseMatch === "exact") return { match: true, confidence: "exact" };
  if (caseMatch === "initial") return { match: true, confidence: "strong" };

  const caseParties = caseName.split(/\s+v\.?\s+|\s+vs\.?\s+|\s+and\s+/i);
  for (const party of caseParties) {
    const pm = textContainsName(party.trim(), firstName, lastName);
    if (pm) return { match: true, confidence: pm === "exact" ? "exact" : "strong" };
  }

  if (result.party && Array.isArray(result.party)) {
    for (const p of result.party) {
      const pm = textContainsName(p, firstName, lastName);
      if (pm) return { match: true, confidence: pm === "exact" ? "exact" : "strong" };
    }
  }

  if (result.recap_documents && Array.isArray(result.recap_documents)) {
    for (const doc of result.recap_documents) {
      const searchable = `${doc.description || ""} ${doc.snippet || ""}`;
      const dm = textContainsName(searchable, firstName, lastName);
      if (dm) return { match: true, confidence: "strong" };
    }
  }

  return { match: false, confidence: "none" };
}

async function fetchCourtListenerResults(
  query: string,
  stateParam: string,
): Promise<CourtResult[]> {
  try {
    const url = `https://www.courtlistener.com/api/rest/v4/search/?q=${encodeURIComponent(query)}&type=r${stateParam}&format=json`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    const response = await fetch(url, {
      headers: { "User-Agent": "MTOS-CRM/1.0 (Legal Background Check)" },
      signal: controller.signal,
    });
    clearTimeout(timeout);
    if (!response.ok) return [];
    const data = (await response.json()) as { results?: CourtResult[] };
    return data.results || [];
  } catch {
    return [];
  }
}

async function searchCourtRecords(person: {
  first_name: string;
  last_name: string;
  state?: string;
}): Promise<BackgroundRecord[] | null> {
  const firstName = person.first_name.trim();
  const lastName = person.last_name.trim();
  const stateParam = person.state
    ? `&state=${encodeURIComponent(person.state)}`
    : "";

  const exactSearches = [
    `"${firstName} ${lastName}"`,
    `"${lastName}, ${firstName}"`,
  ];
  const broadSearch = `${lastName} AND ${firstName}`;

  const seen = new Set<string>();
  const records: BackgroundRecord[] = [];

  try {
    const exactBatches = await Promise.all(
      exactSearches.map((q) => fetchCourtListenerResults(q, stateParam)),
    );
    for (const batch of exactBatches) {
      for (const result of batch) {
        const docketNum = result.docketNumber || "";
        const caseName = result.caseName || "";
        const key = `${docketNum}|${caseName}|${result.dateFiled || ""}`;
        if (seen.has(key)) continue;
        seen.add(key);

        const { confidence } = nameMatchesResult(result, firstName, lastName);

        records.push({
          type: "COURT_RECORD",
          description: caseName || "Court record found",
          date: result.dateFiled || undefined,
          jurisdiction: result.court || undefined,
          severity: confidence === "exact" ? "high" : "medium",
        });
      }
    }

    const broadResults = await fetchCourtListenerResults(broadSearch, stateParam);
    for (const result of broadResults) {
      const docketNum = result.docketNumber || "";
      const caseName = result.caseName || "";
      const key = `${docketNum}|${caseName}|${result.dateFiled || ""}`;
      if (seen.has(key)) continue;
      seen.add(key);

      const { match, confidence } = nameMatchesResult(result, firstName, lastName);
      if (!match) continue;

      records.push({
        type: "COURT_RECORD",
        description: caseName || "Court record found",
        date: result.dateFiled || undefined,
        jurisdiction: result.court || undefined,
        severity: confidence === "exact" ? "high" : "medium",
      });
    }
  } catch (err) {
    logger.warn({ err }, "Court record search failed — continuing");
    return null;
  }

  if (records.length === 0) {
    const fallback = await fetchCourtListenerResults(lastName, stateParam);
    for (const result of fallback) {
      const { match, confidence } = nameMatchesResult(result, firstName, lastName);
      if (!match) continue;
      const caseName = result.caseName || "";
      records.push({
        type: "COURT_RECORD",
        description: caseName || "Court record found",
        date: result.dateFiled || undefined,
        jurisdiction: result.court || undefined,
        severity: confidence === "exact" ? "high" : "medium",
      });
    }
  }

  return records.slice(0, 10);
}

async function checkOFACList(person: {
  first_name: string;
  last_name: string;
}): Promise<BackgroundRecord[] | null> {
  const records: BackgroundRecord[] = [];

  try {
    const name = encodeURIComponent(`${person.first_name} ${person.last_name}`);
    const url = `https://search.ofac-api.com/v3?name=${name}&minScore=95`;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);

    const response = await fetch(url, {
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (response.ok) {
      const data = await response.json() as { matches?: Array<{ name?: string; programs?: string[]; score?: number }> };
      if (data.matches && Array.isArray(data.matches) && data.matches.length > 0) {
        for (const match of data.matches.slice(0, 5)) {
          records.push({
            type: "OFAC_SANCTIONS",
            description: `OFAC match: ${match.name || "Unknown"} (Programs: ${match.programs?.join(", ") || "N/A"})`,
            severity: "high",
          });
        }
      }
    }
  } catch (err) {
    logger.warn({ err }, "OFAC check failed — continuing");
    return null;
  }

  return records;
}
