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

async function searchCourtRecords(person: {
  first_name: string;
  last_name: string;
  state?: string;
}): Promise<BackgroundRecord[] | null> {
  const records: BackgroundRecord[] = [];

  try {
    const query = encodeURIComponent(`${person.first_name} ${person.last_name}`);
    const stateParam = person.state ? `&state=${encodeURIComponent(person.state)}` : "";
    const url = `https://www.courtlistener.com/api/rest/v4/search/?q=${query}&type=r${stateParam}&format=json`;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);

    const response = await fetch(url, {
      headers: {
        "User-Agent": "MTOS-CRM/1.0 (Legal Background Check)",
      },
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (response.ok) {
      const data = await response.json() as { results?: Array<{ caseName?: string; dateFiled?: string; court?: string; docketNumber?: string }> };
      if (data.results && Array.isArray(data.results)) {
        for (const result of data.results.slice(0, 10)) {
          records.push({
            type: "COURT_RECORD",
            description: result.caseName || "Court record found",
            date: result.dateFiled || undefined,
            jurisdiction: result.court || undefined,
            severity: "medium",
          });
        }
      }
    }
  } catch (err) {
    logger.warn({ err }, "Court record search failed — continuing");
    return null;
  }

  return records;
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
