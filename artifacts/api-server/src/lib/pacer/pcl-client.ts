/**
 * PACER PCL (Public Case Locator) Search API client.
 *
 * Reads credentials from the integrations vault — provider key "pacer".
 * Vault fields:
 *   api_key        → PACER username (loginId for the auth endpoint)
 *   client_secret  → PACER password
 *
 * Auth flow (per https://pacer.uscourts.gov/help/pacer/case-search-only-api):
 *   1. POST https://pacer.login.uscourts.gov/services/cso-auth
 *      { loginId, password }                         → { nextGenCSO, loginResult }
 *   2. POST https://pcl.uscourts.gov/pcl-public-api/rest/cases/find
 *      Cookie: NextGenCSO=<token>                    → JSON results
 *
 * Per-page billing applies on the PACER side — every cases/find call costs
 * money in production. The hub wraps this client behind an opt-in lane so
 * operators only pay when they explicitly choose to wire up PACER.
 *
 * Error semantics:
 *   - NOT_CONFIGURED   → returned when no active "pacer" integration exists
 *                        (or credentials decrypt to empty). The hub adapter
 *                        translates this into a NOT_RUN lane result.
 *   - AUTH_FAILED      → token endpoint rejected the credentials.
 *   - SOURCE_UNREACHABLE → network/HTTP error against either endpoint.
 *   - OK               → search returned (zero or more cases).
 *
 * This client never throws to its caller; it returns a discriminated-union
 * outcome so the hub adapter (which itself never throws) can map states
 * deterministically.
 */
import { db, integrationsTable } from "@workspace/db";
import { and, eq } from "drizzle-orm";
import { getIntegrationCredentialsById } from "../../routes/integrations";
import { logger } from "../logger";

const PACER_AUTH_URL = "https://pacer.login.uscourts.gov/services/cso-auth";
const PCL_SEARCH_URL = "https://pcl.uscourts.gov/pcl-public-api/rest/cases/find";

export interface PclCase {
  caseNumberFull?: string;
  caseTitle?: string;
  caseYear?: number;
  courtId?: string;
  courtType?: string;
  dateFiled?: string;
  jurisdictionType?: string;
  natureOfSuit?: string;
}

export type PclSearchOutcome =
  | { ok: true; cases: PclCase[]; truncated: boolean }
  | { ok: false; reason: "NOT_CONFIGURED" }
  | { ok: false; reason: "AUTH_FAILED"; message: string }
  | { ok: false; reason: "SOURCE_UNREACHABLE"; message: string };

export interface PclSearchInput {
  firstName: string;
  lastName: string;
  dateOfBirth?: string | null; // YYYY-MM-DD; PCL accepts dobStart/dobEnd
}

interface PacerCredentials {
  loginId: string;
  password: string;
}

async function loadPacerCredentials(): Promise<PacerCredentials | null> {
  const rows = await db
    .select({ id: integrationsTable.id })
    .from(integrationsTable)
    .where(
      and(
        eq(integrationsTable.provider, "pacer"),
        eq(integrationsTable.status, "active"),
      ),
    )
    .limit(1);
  const row = rows[0];
  if (!row) return null;

  const creds = await getIntegrationCredentialsById(row.id);
  if (!creds) return null;
  if (creds._decryption_errors && creds._decryption_errors.length) {
    logger.error(
      { fields: creds._decryption_errors, integration_id: row.id },
      "pacer credential decryption failed",
    );
    return null;
  }
  const loginId = typeof creds.api_key === "string" ? creds.api_key.trim() : "";
  const password = typeof creds.client_secret === "string" ? creds.client_secret.trim() : "";
  if (!loginId || !password) return null;
  return { loginId, password };
}

async function fetchToken(
  creds: PacerCredentials,
): Promise<{ ok: true; token: string } | { ok: false; reason: "AUTH_FAILED" | "SOURCE_UNREACHABLE"; message: string }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  try {
    const resp = await fetch(PACER_AUTH_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ loginId: creds.loginId, password: creds.password }),
      signal: controller.signal,
    });
    clearTimeout(timeout);
    if (!resp.ok) {
      return { ok: false, reason: "AUTH_FAILED", message: `auth HTTP ${resp.status}` };
    }
    const json = (await resp.json().catch(() => ({}))) as {
      nextGenCSO?: string;
      loginResult?: string;
      errorDescription?: string;
    };
    const token = typeof json.nextGenCSO === "string" ? json.nextGenCSO.trim() : "";
    if (!token) {
      return {
        ok: false,
        reason: "AUTH_FAILED",
        message: json.errorDescription || `auth result=${json.loginResult ?? "unknown"}`,
      };
    }
    return { ok: true, token };
  } catch (err) {
    clearTimeout(timeout);
    return {
      ok: false,
      reason: "SOURCE_UNREACHABLE",
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Search the PACER Case Locator for any case in which the given person
 * appears as a party. Returns an honest discriminated-union outcome —
 * never throws.
 */
export async function searchPcl(input: PclSearchInput): Promise<PclSearchOutcome> {
  // Strict no-throw contract: wrap the entire pipeline (incl. credential
  // load, which touches the DB and vault decryption) so internal failures
  // surface as SOURCE_UNREACHABLE instead of unhandled exceptions.
  try {
    return await searchPclInner(input);
  } catch (err) {
    logger.error(
      { err: err instanceof Error ? err.message : String(err) },
      "PACER PCL client unexpected error (degraded to SOURCE_UNREACHABLE)",
    );
    return {
      ok: false,
      reason: "SOURCE_UNREACHABLE",
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

async function searchPclInner(input: PclSearchInput): Promise<PclSearchOutcome> {
  const creds = await loadPacerCredentials();
  if (!creds) return { ok: false, reason: "NOT_CONFIGURED" };

  const tokenResp = await fetchToken(creds);
  if (!tokenResp.ok) return tokenResp;

  const body: Record<string, unknown> = {
    lastName: input.lastName,
    firstName: input.firstName,
  };
  if (input.dateOfBirth) {
    // PCL supports dobStart/dobEnd as a range filter (YYYY-MM-DD).
    body.dobStart = input.dateOfBirth;
    body.dobEnd = input.dateOfBirth;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  try {
    const resp = await fetch(`${PCL_SEARCH_URL}?page=0`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        Cookie: `NextGenCSO=${tokenResp.token}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    clearTimeout(timeout);
    if (!resp.ok) {
      return {
        ok: false,
        reason: "SOURCE_UNREACHABLE",
        message: `search HTTP ${resp.status}`,
      };
    }
    const json = (await resp.json().catch(() => ({}))) as {
      content?: PclCase[];
      pageInfo?: { totalElements?: number };
    };
    const cases = Array.isArray(json.content) ? json.content.slice(0, 25) : [];
    const total = typeof json.pageInfo?.totalElements === "number" ? json.pageInfo.totalElements : cases.length;
    return { ok: true, cases, truncated: total > cases.length };
  } catch (err) {
    clearTimeout(timeout);
    return {
      ok: false,
      reason: "SOURCE_UNREACHABLE",
      message: err instanceof Error ? err.message : String(err),
    };
  }
}
