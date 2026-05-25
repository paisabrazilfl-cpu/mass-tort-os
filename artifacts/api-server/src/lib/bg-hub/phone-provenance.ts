/**
 * Phone provenance via Telnyx Number Lookup
 * (https://developers.telnyx.com/api/number-lookup).
 *
 * Telnyx's Lookup API returns the carrier + line type for any North
 * American number. We derive a burner-risk signal from those fields:
 *
 *   line_type=mobile, carrier known         → low risk
 *   line_type=fixed_voip                    → moderate risk (Google Voice,
 *                                              TextNow, etc — common burner
 *                                              path in mass-tort fraud)
 *   line_type=non_fixed_voip                → high risk (anonymous SIP
 *                                              numbers; cheap to spin up)
 *   line_type=toll_free                     → moderate risk (claimant
 *                                              should not be reachable
 *                                              via a toll-free number)
 *   carrier unknown + recently-ported       → high risk
 *
 * We reuse the existing `telnyx` integration row's api_key — no
 * separate signup. The Lookup endpoint is billed at fractions of a
 * cent per call so this adds minimal operating cost while catching the
 * single biggest fraud-vector signal in lead intake.
 */
import { logger } from "../logger";
import { getIntegrationCredentials } from "../../routes/integrations";

const TELNYX_LOOKUP_BASE = process.env["TELNYX_LOOKUP_BASE"] || "https://api.telnyx.com";
const TELNYX_LOOKUP_TIMEOUT_MS = Number(process.env["TELNYX_LOOKUP_TIMEOUT_MS"] ?? 8_000);

export interface PhoneLookupResult {
  status: "ok" | "unconfigured" | "error";
  /** E.164 phone number we queried, echoed back for the audit trail. */
  phone: string;
  /** mobile / landline / fixed_voip / non_fixed_voip / toll_free / null */
  line_type: string | null;
  /** Carrier name as returned by Telnyx. */
  carrier: string | null;
  /** Two-letter country code. */
  country_code: string | null;
  /** True when Telnyx reported the number has been ported in the last 60d. */
  recently_ported: boolean;
  /** Adapter's burner-risk verdict. */
  risk: "low" | "moderate" | "high" | "unknown";
  /** Flag names compatible with the bg-hub escalation taxonomy. */
  flags: string[];
  note?: string;
}

function normalizeToE164(raw: string): string | null {
  const digits = raw.replace(/\D+/g, "");
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length > 0 && raw.startsWith("+")) return `+${digits}`;
  return null;
}

async function resolveTelnyxKey(firmId?: number): Promise<string | null> {
  try {
    const creds = await getIntegrationCredentials("telnyx", firmId);
    const key = (creds && typeof creds.api_key === "string" && creds.api_key) || process.env["TELNYX_API_KEY"] || "";
    return key || null;
  } catch (err) {
    logger.warn({ err }, "Telnyx credential resolve failed");
    return process.env["TELNYX_API_KEY"] ?? null;
  }
}

/**
 * Run a Telnyx Number Lookup. Network-safe: every error path returns a
 * typed envelope, never throws. The caller (bg-hub adapter) maps the
 * envelope onto lane flags.
 */
export async function lookupPhoneProvenance(rawPhone: string, firmId?: number): Promise<PhoneLookupResult> {
  const phone = normalizeToE164(String(rawPhone || ""));
  if (!phone) {
    return {
      status: "error",
      phone: String(rawPhone || ""),
      line_type: null,
      carrier: null,
      country_code: null,
      recently_ported: false,
      risk: "unknown",
      flags: ["phone_unparseable"],
      note: "Could not normalize to E.164",
    };
  }
  const apiKey = await resolveTelnyxKey(firmId);
  if (!apiKey) {
    return {
      status: "unconfigured",
      phone,
      line_type: null,
      carrier: null,
      country_code: null,
      recently_ported: false,
      risk: "unknown",
      flags: ["phone_provenance_unconfigured"],
      note: "No Telnyx integration configured — phone-provenance check skipped.",
    };
  }

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TELNYX_LOOKUP_TIMEOUT_MS);
  try {
    const url = `${TELNYX_LOOKUP_BASE.replace(/\/$/, "")}/v2/number_lookup/${encodeURIComponent(phone)}?type=carrier`;
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Accept": "application/json",
        "User-Agent": "mass-tort-os/bg-hub-phone",
      },
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return {
        status: "error",
        phone,
        line_type: null,
        carrier: null,
        country_code: null,
        recently_ported: false,
        risk: "unknown",
        flags: ["phone_lookup_unreachable"],
        note: `Telnyx Lookup HTTP ${res.status}: ${text.slice(0, 200)}`,
      };
    }
    const json = (await res.json()) as {
      data?: {
        phone_number?: string;
        carrier?: { name?: string; type?: string; mobile_country_code?: string };
        country_code?: string;
        portability?: { altspid?: string; previous_spid?: string; ported_date?: string };
      };
    };
    const data = json.data ?? {};
    const lineType = (data.carrier?.type || "").toLowerCase() || null;
    const carrierName = data.carrier?.name ?? null;
    const countryCode = data.country_code ?? data.carrier?.mobile_country_code ?? null;
    const portedDateRaw = data.portability?.ported_date;
    const portedAt = portedDateRaw ? new Date(portedDateRaw) : null;
    const recentlyPorted = !!(portedAt && Number.isFinite(portedAt.getTime()) && Date.now() - portedAt.getTime() < 60 * 86400 * 1000);
    const verdict = classify(lineType, carrierName, recentlyPorted);
    return {
      status: "ok",
      phone,
      line_type: lineType,
      carrier: carrierName,
      country_code: countryCode,
      recently_ported: recentlyPorted,
      risk: verdict.risk,
      flags: verdict.flags,
    };
  } catch (err) {
    if ((err as { name?: string }).name === "AbortError") {
      return {
        status: "error",
        phone,
        line_type: null,
        carrier: null,
        country_code: null,
        recently_ported: false,
        risk: "unknown",
        flags: ["phone_lookup_unreachable"],
        note: `Telnyx Lookup timeout after ${TELNYX_LOOKUP_TIMEOUT_MS}ms`,
      };
    }
    return {
      status: "error",
      phone,
      line_type: null,
      carrier: null,
      country_code: null,
      recently_ported: false,
      risk: "unknown",
      flags: ["phone_lookup_unreachable"],
      note: `Telnyx Lookup network error: ${err instanceof Error ? err.message : String(err)}`,
    };
  } finally {
    clearTimeout(timer);
  }
}

function classify(
  lineType: string | null,
  carrier: string | null,
  recentlyPorted: boolean,
): { risk: PhoneLookupResult["risk"]; flags: string[] } {
  const flags: string[] = [];
  let risk: PhoneLookupResult["risk"] = "low";

  if (!lineType) {
    flags.push("phone_carrier_unknown");
    risk = "moderate";
  }
  // Telnyx returns `non_fixed_voip` for SIP / softphone / Google Voice /
  // TextNow class numbers. These are the canonical burner signal.
  // Risk transitions: low → moderate → high. We use a numeric weight
  // internally to avoid the cascade of "if risk !== 'high'" guards.
  const rankOf = (r: PhoneLookupResult["risk"]): number =>
    r === "high" ? 3 : r === "moderate" ? 2 : r === "low" ? 1 : 0;
  const bump = (next: PhoneLookupResult["risk"]): void => {
    if (rankOf(next) > rankOf(risk)) risk = next;
  };
  if (lineType === "non_fixed_voip") {
    flags.push("phone_non_fixed_voip");
    bump("high");
  } else if (lineType === "fixed_voip" || lineType === "voip") {
    flags.push("phone_voip");
    bump("moderate");
  } else if (lineType === "toll_free" || lineType === "tollfree") {
    flags.push("phone_toll_free");
    bump("moderate");
  }
  if (recentlyPorted) {
    flags.push("phone_recently_ported");
    bump("moderate");
  }
  if (carrier && /textnow|google\s*voice|pinger|bandwidth/i.test(carrier)) {
    flags.push("phone_known_burner_carrier");
    bump("high");
  }
  return { risk, flags };
}

// Test-only override
let __testOverride: ((rawPhone: string) => Promise<PhoneLookupResult>) | null = null;
export function __setPhoneLookupTestOverride(fn: ((rawPhone: string) => Promise<PhoneLookupResult>) | null): void {
  __testOverride = fn;
}
export async function _lookupPhoneProvenanceWithOverride(rawPhone: string, firmId?: number): Promise<PhoneLookupResult> {
  if (__testOverride) return __testOverride(rawPhone);
  return lookupPhoneProvenance(rawPhone, firmId);
}
