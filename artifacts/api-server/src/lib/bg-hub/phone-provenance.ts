/**
 * Phone provenance / line-type intelligence.
 *
 * Primary provider: Twilio Lookup v2 (https://www.twilio.com/docs/lookup/v2-api)
 * Fallback provider: Telnyx Number Lookup (https://developers.telnyx.com/api/number-lookup)
 *
 * Both APIs return the carrier + line type for a North American number. We
 * derive a burner-risk signal from those fields:
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
 * Provider selection: if a `twilio_lookup` integration is connected in the
 * vault we use Twilio Lookup v2 (account_sid + auth token); otherwise we fall
 * back to the `telnyx` integration row's api_key. Either Lookup endpoint is
 * billed at fractions of a cent per call so this adds minimal operating cost
 * while catching the single biggest fraud-vector signal in lead intake.
 */
import { logger } from "../logger";
import { getIntegrationCredentials } from "../../routes/integrations";

const TELNYX_LOOKUP_BASE = process.env["TELNYX_LOOKUP_BASE"] || "https://api.telnyx.com";
const TELNYX_LOOKUP_TIMEOUT_MS = Number(process.env["TELNYX_LOOKUP_TIMEOUT_MS"] ?? 8_000);

const TWILIO_LOOKUP_BASE = process.env["TWILIO_LOOKUP_BASE"] || "https://lookups.twilio.com";
const TWILIO_LOOKUP_TIMEOUT_MS = Number(process.env["TWILIO_LOOKUP_TIMEOUT_MS"] ?? 8_000);
// Twilio Lookup "Fields" (data packages) to request. `line_type_intelligence`
// is the standard package every account can call and is all we need for
// VoIP/carrier filtering. SIM-swap is a separately-entitled package — enable it
// by setting TWILIO_LOOKUP_FIELDS=line_type_intelligence,sim_swap once the
// account has that add-on; the parser reads it defensively if present.
const TWILIO_LOOKUP_FIELDS = process.env["TWILIO_LOOKUP_FIELDS"] || "line_type_intelligence";

export interface PhoneLookupResult {
  status: "ok" | "unconfigured" | "error";
  /** Which adapter produced this result, for the audit trail. */
  provider?: "twilio_lookup" | "telnyx";
  /** E.164 phone number we queried, echoed back for the audit trail. */
  phone: string;
  /** mobile / landline / fixed_voip / non_fixed_voip / toll_free / null */
  line_type: string | null;
  /** Carrier name as returned by the provider. */
  carrier: string | null;
  /** Two-letter country code. */
  country_code: string | null;
  /** True when the provider reported a recent port-in / SIM-swap. */
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

function errEnvelope(
  phone: string,
  provider: PhoneLookupResult["provider"],
  note: string,
): PhoneLookupResult {
  return {
    status: "error",
    provider,
    phone,
    line_type: null,
    carrier: null,
    country_code: null,
    recently_ported: false,
    risk: "unknown",
    flags: ["phone_lookup_unreachable"],
    note,
  };
}

async function resolveTwilioLookupCreds(
  firmId?: number,
): Promise<{ accountSid: string; authToken: string } | null> {
  try {
    const creds = await getIntegrationCredentials("twilio_lookup", firmId);
    const accountSid = creds && typeof creds.account_sid === "string" ? creds.account_sid : "";
    const authToken = creds && typeof creds.api_key === "string" ? creds.api_key : "";
    if (accountSid && authToken) return { accountSid, authToken };
    return null;
  } catch (err) {
    logger.warn({ err }, "Twilio Lookup credential resolve failed");
    return null;
  }
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
 * Run a phone line-type lookup. Provider-aware: prefers Twilio Lookup v2 when
 * a `twilio_lookup` integration is connected, else falls back to Telnyx.
 * Network-safe: every error path returns a typed envelope, never throws. The
 * caller (bg-hub phone adapter) maps the envelope onto lane flags.
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

  const twilio = await resolveTwilioLookupCreds(firmId);
  if (twilio) return lookupViaTwilio(phone, twilio.accountSid, twilio.authToken);

  const telnyxKey = await resolveTelnyxKey(firmId);
  if (telnyxKey) return lookupViaTelnyx(phone, telnyxKey);

  return {
    status: "unconfigured",
    phone,
    line_type: null,
    carrier: null,
    country_code: null,
    recently_ported: false,
    risk: "unknown",
    flags: ["phone_provenance_unconfigured"],
    note: "No Twilio Lookup or Telnyx integration configured — phone line-type check skipped.",
  };
}

/** Map Twilio Lookup v2 line-type values onto the classify() taxonomy. */
function mapTwilioLineType(t: string | null | undefined): string | null {
  if (!t) return null;
  switch (t) {
    case "nonFixedVoip":
      return "non_fixed_voip";
    case "fixedVoip":
      return "fixed_voip";
    case "tollFree":
      return "toll_free";
    default:
      return t.toLowerCase();
  }
}

async function lookupViaTwilio(
  phone: string,
  accountSid: string,
  authToken: string,
): Promise<PhoneLookupResult> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TWILIO_LOOKUP_TIMEOUT_MS);
  try {
    const url =
      `${TWILIO_LOOKUP_BASE.replace(/\/$/, "")}/v2/PhoneNumbers/${encodeURIComponent(phone)}` +
      `?Fields=${encodeURIComponent(TWILIO_LOOKUP_FIELDS)}`;
    const auth = Buffer.from(`${accountSid}:${authToken}`).toString("base64");
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: {
        "Authorization": `Basic ${auth}`,
        "Accept": "application/json",
        "User-Agent": "mass-tort-os/bg-hub-phone",
      },
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return errEnvelope(phone, "twilio_lookup", `Twilio Lookup HTTP ${res.status}: ${text.slice(0, 200)}`);
    }
    const json = (await res.json()) as {
      valid?: boolean;
      country_code?: string | null;
      line_type_intelligence?: { type?: string | null; carrier_name?: string | null; error_code?: number | null } | null;
      sim_swap?: { last_sim_swap?: { swapped_in_period?: boolean | null } | null } | null;
    };
    const lti = json.line_type_intelligence ?? null;
    const lineType = mapTwilioLineType(lti?.type ?? null);
    const carrierName = lti?.carrier_name ?? null;
    const countryCode = json.country_code ?? null;
    const recentlyPorted = !!json.sim_swap?.last_sim_swap?.swapped_in_period;
    const verdict = classify(lineType, carrierName, recentlyPorted);
    return {
      status: "ok",
      provider: "twilio_lookup",
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
      return errEnvelope(phone, "twilio_lookup", `Twilio Lookup timeout after ${TWILIO_LOOKUP_TIMEOUT_MS}ms`);
    }
    return errEnvelope(phone, "twilio_lookup", `Twilio Lookup network error: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    clearTimeout(timer);
  }
}

async function lookupViaTelnyx(phone: string, apiKey: string): Promise<PhoneLookupResult> {
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
      return errEnvelope(phone, "telnyx", `Telnyx Lookup HTTP ${res.status}: ${text.slice(0, 200)}`);
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
      provider: "telnyx",
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
      return errEnvelope(phone, "telnyx", `Telnyx Lookup timeout after ${TELNYX_LOOKUP_TIMEOUT_MS}ms`);
    }
    return errEnvelope(phone, "telnyx", `Telnyx Lookup network error: ${err instanceof Error ? err.message : String(err)}`);
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
  // Providers return `non_fixed_voip` for SIP / softphone / Google Voice /
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
