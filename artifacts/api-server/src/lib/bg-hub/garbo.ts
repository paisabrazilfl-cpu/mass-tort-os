/**
 * Garbo (https://garbo.io) API client for the bg-hub.
 *
 * Garbo is an API-first, FCRA-compliant background check provider built
 * for consumer-facing screening (dating, marketplaces, claimant intake).
 * For mass-tort claimant qualification it's the cheapest legally-clean
 * way to cover the manual NSOPW lane and augment the criminal-court
 * lane with arrest + violence-related public records in one call.
 *
 * SCOPE & HONESTY NOTE
 * ─────────────────────
 * The architectural scaffold here is complete: credential lookup
 * (firm-scoped, encrypted, falls back to env), request body shape,
 * response→flag mapping, retry-and-timeout handling, fail-open
 * behaviour, integration with the rest of the bg-hub. What is NOT
 * filled in is the exact endpoint path + request/response shape,
 * because the Garbo API contract is behind their developer-portal
 * sign-up wall and I refuse to fabricate it.
 *
 * To activate this adapter ONCE you have access:
 *   1. Sign up at https://garbo.io and obtain an API key.
 *   2. In the MTOS Integrations page, add a "Garbo" integration row
 *      and paste the api_key (and optionally api_url to override the
 *      default base URL).
 *   3. Read Garbo's API docs and replace the THREE marked
 *      "OPERATOR-CONFIRM" blocks below with the real endpoint,
 *      request body, and response-field paths. The function signatures
 *      and return shapes do NOT need to change — the rest of the bg-hub
 *      is already wired to consume the canonical `GarboCheckResult` shape.
 *
 * Failure modes (all already implemented):
 *   - no integration row / no api_key → adapter falls back to
 *     the existing smart-link path; no exception escapes.
 *   - HTTP error / timeout            → adapter logs + returns "error"
 *                                        outcome; bg-hub forces REVIEW.
 *   - 0 hits                          → "ok" with empty arrays.
 *   - ≥1 hit                          → "ok" with normalized records.
 *
 * Source of truth for the credential flow: lib/integrations.ts →
 * getIntegrationCredentials("garbo", firmId). That helper performs the
 * encrypted-at-rest decrypt with id-scoped AAD; we never store the
 * Garbo key plaintext.
 */
import { logger } from "../logger";
import { getIntegrationCredentials } from "../../routes/integrations";

const DEFAULT_GARBO_BASE = "https://api.garbo.io";
const GARBO_TIMEOUT_MS = Number(process.env["GARBO_TIMEOUT_MS"] ?? 15_000);

export interface GarboInput {
  first_name: string;
  last_name: string;
  /** Optional ISO-8601 (YYYY-MM-DD) — disambiguates name collisions. */
  date_of_birth?: string | null;
  /** Optional 2-letter US state code — narrows the search. */
  state?: string | null;
  /** Optional. Email/phone help Garbo's identity-resolution layer. */
  email?: string | null;
  phone?: string | null;
}

export interface GarboHit {
  /** Garbo's own record id, returned verbatim so the operator can audit. */
  record_id: string;
  /** Severity bucket Garbo assigns. We pass it through unchanged. */
  category: "violent" | "sexual" | "fraud" | "theft" | "other" | "arrest" | "unknown";
  /** Free-text description from Garbo. */
  description: string;
  /** ISO-8601 record date when Garbo provides one. */
  date?: string;
  /** Jurisdiction string (state or county). */
  jurisdiction?: string;
  /** True if the record matched the sex-offender registry specifically. */
  is_sex_offender_registry?: boolean;
}

export type GarboCheckResult =
  | { status: "ok"; hits: GarboHit[]; raw: unknown; checked_at: string }
  | { status: "unconfigured"; note: string }
  | { status: "error"; note: string };

/**
 * Resolve the Garbo api_key + base URL from the firm's encrypted
 * integration row. If no firm-scoped row exists, fall through to the
 * GARBO_API_KEY env var so a single-firm deployment can configure via
 * env without touching the UI. Returns null if neither is configured.
 */
async function resolveGarboCreds(firmId?: number): Promise<{ apiKey: string; baseUrl: string } | null> {
  try {
    const creds = await getIntegrationCredentials("garbo", firmId);
    const apiKey =
      (creds && typeof creds.api_key === "string" && creds.api_key) ||
      process.env["GARBO_API_KEY"] ||
      "";
    if (!apiKey) return null;
    const baseUrl =
      (creds && typeof creds.api_url === "string" && creds.api_url) ||
      process.env["GARBO_API_URL"] ||
      DEFAULT_GARBO_BASE;
    return { apiKey, baseUrl: baseUrl.replace(/\/$/, "") };
  } catch (err) {
    logger.warn({ err }, "Garbo credential resolve failed — falling back to env / smart-link");
    const apiKey = process.env["GARBO_API_KEY"];
    if (!apiKey) return null;
    const baseUrl = (process.env["GARBO_API_URL"] || DEFAULT_GARBO_BASE).replace(/\/$/, "");
    return { apiKey, baseUrl };
  }
}

export function isGarboConfigured(firmId?: number): Promise<boolean> {
  return resolveGarboCreds(firmId).then((c) => c !== null);
}

/**
 * Run a Garbo check for one person. Network-safe: every error returns
 * a typed envelope, never throws. Caller decides whether the lane
 * status should escalate to REVIEW or fall through to smart-link.
 */
export async function runGarboCheck(input: GarboInput, firmId?: number): Promise<GarboCheckResult> {
  const creds = await resolveGarboCreds(firmId);
  if (!creds) {
    return {
      status: "unconfigured",
      note: "No Garbo integration configured. Add an integration row with provider=garbo and paste the API key, or set GARBO_API_KEY.",
    };
  }

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), GARBO_TIMEOUT_MS);
  try {
    // ── OPERATOR-CONFIRM ── (1 of 3) ─────────────────────────────────
    // Replace this URL fragment with Garbo's documented endpoint path.
    // Common shapes for similar APIs are POST /v1/checks or
    // POST /v1/background_check. The bg-hub doesn't care which — only
    // that the function returns a GarboCheckResult.
    const endpoint = `${creds.baseUrl}/v1/background_check`;

    // ── OPERATOR-CONFIRM ── (2 of 3) ─────────────────────────────────
    // Replace this body with Garbo's documented request shape. Most
    // FCRA-compliant providers want: first/last name, optional DOB,
    // optional state, and a `permissible_purpose` string. Garbo's docs
    // will name the exact field for that permissible purpose; for a
    // mass-tort claimant intake it is "business transaction initiated
    // by the consumer" per 15 USC 1681b(a)(3)(F).
    const body = {
      first_name: input.first_name,
      last_name: input.last_name,
      date_of_birth: input.date_of_birth ?? undefined,
      state: input.state ?? undefined,
      email: input.email ?? undefined,
      phone: input.phone ?? undefined,
      // FCRA permissible-purpose stamp. Adjust the literal to whatever
      // value Garbo's API enum expects (e.g. "business_initiated_by_consumer").
      permissible_purpose: "business_initiated_by_consumer",
    };

    const res = await fetch(endpoint, {
      method: "POST",
      signal: ctrl.signal,
      headers: {
        "Authorization": `Bearer ${creds.apiKey}`,
        "Content-Type": "application/json",
        "Accept": "application/json",
        "User-Agent": "mass-tort-os/bg-hub-garbo",
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return {
        status: "error",
        note: `Garbo HTTP ${res.status}: ${text.slice(0, 200)}`,
      };
    }
    const raw = (await res.json()) as unknown;

    // ── OPERATOR-CONFIRM ── (3 of 3) ─────────────────────────────────
    // Replace this projection with the actual response → hit mapping
    // from Garbo's documented response shape. The defensive `??` chain
    // below assumes a `{records: [{id, category, description, date,
    // jurisdiction, registries: [...]}]}` shape; adjust the field names
    // to whatever Garbo returns.
    const records = Array.isArray((raw as any)?.records) ? (raw as any).records : [];
    const hits: GarboHit[] = records.map((r: any) => {
      const registries: string[] = Array.isArray(r?.registries) ? r.registries : [];
      const isSexOffender = registries.some((s) => /sex.?offender|nsopw/i.test(String(s)));
      return {
        record_id: String(r?.id ?? r?.record_id ?? ""),
        category: normalizeCategory(r?.category),
        description: String(r?.description ?? "Garbo record"),
        date: typeof r?.date === "string" ? r.date : undefined,
        jurisdiction: typeof r?.jurisdiction === "string" ? r.jurisdiction : undefined,
        is_sex_offender_registry: isSexOffender,
      } satisfies GarboHit;
    });

    return {
      status: "ok",
      hits,
      raw,
      checked_at: new Date().toISOString(),
    };
  } catch (err) {
    if ((err as { name?: string }).name === "AbortError") {
      return { status: "error", note: `Garbo timeout after ${GARBO_TIMEOUT_MS}ms` };
    }
    return {
      status: "error",
      note: `Garbo network error: ${err instanceof Error ? err.message : String(err)}`,
    };
  } finally {
    clearTimeout(timer);
  }
}

function normalizeCategory(raw: unknown): GarboHit["category"] {
  const s = String(raw ?? "").toLowerCase();
  if (/sex|nsopw|registry/.test(s)) return "sexual";
  if (/violen|assault|battery|murder|manslaughter/.test(s)) return "violent";
  if (/fraud|forgery|embezzle/.test(s)) return "fraud";
  if (/theft|burglary|robbery|larceny/.test(s)) return "theft";
  if (/arrest/.test(s)) return "arrest";
  if (s) return "other";
  return "unknown";
}

// Test-only override hook. Lets tests inject a fake response shape
// without hitting the network.
let __testOverride: ((input: GarboInput) => Promise<GarboCheckResult>) | null = null;
export function __setGarboTestOverride(fn: ((input: GarboInput) => Promise<GarboCheckResult>) | null): void {
  __testOverride = fn;
}
/** Internal hook used by adapters so the test override path stays single-source. */
export async function _runGarboCheckWithOverride(input: GarboInput, firmId?: number): Promise<GarboCheckResult> {
  if (__testOverride) return __testOverride(input);
  return runGarboCheck(input, firmId);
}
