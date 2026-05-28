/**
 * FCC Reassigned Numbers Database (RND) adapter for the bg-hub phone lane.
 *
 * TCPA context: calling a reassigned phone number — one that now belongs to
 * someone other than the consenting party — is a Telephone Consumer Protection
 * Act violation even with prior express written consent. The FCC RND lets
 * callers check whether a number has been reassigned since the consent date.
 *
 * API: GET https://rnd.fcc.gov/reassignment/api/search/snapshot
 * Key: free registration at https://rnd.fcc.gov/  →  x-api-key header
 *
 * callDate: the date of the original consent (or, when unavailable, 90 days
 * ago as a conservative TCPA lookback). If the number was reassigned AFTER
 * callDate, wasReassigned = true.
 *
 * Vault wiring (in order of precedence):
 *   1. Integration vault: provider="fcc_rnd", credential key "api_key"
 *   2. Environment variable: FCC_RND_API_KEY
 *
 * Honesty contract:
 *   "unconfigured" → caller emits phone_not_checked (status quo — no regression)
 *   "clean"        → number not reassigned since callDate; caller can PASS the lane
 *   "reassigned"   → TCPA risk; caller emits fcc_rnd_reassigned → REVIEW_REQUIRED
 *   "invalid"      → number not in RND or non-US; caller emits fcc_rnd_not_in_rnd
 *   "unavailable"  → API down/rate-limited; caller emits fcc_rnd_unavailable
 */

import { logger } from "../logger";
import { getIntegrationCredentials } from "../../routes/integrations";

const FCC_RND_BASE = "https://rnd.fcc.gov/reassignment/api/search/snapshot";
const FCC_RND_TIMEOUT_MS = Number(process.env["FCC_RND_TIMEOUT_MS"] ?? 8_000);

// Conservative TCPA lookback when no explicit consent date is available.
const DEFAULT_LOOKBACK_DAYS = 90;

export type FccRndResult =
  | { status: "unconfigured" }
  | { status: "clean"; phone: string; call_date: string; checked_at: string }
  | { status: "reassigned"; phone: string; call_date: string; last_assigned_date: string | null; checked_at: string }
  | { status: "invalid"; phone: string; note: string }
  | { status: "unavailable"; note: string };

async function resolveKey(firmId?: number): Promise<string | null> {
  try {
    const creds = await getIntegrationCredentials("fcc_rnd", firmId);
    const key =
      (creds && typeof creds.api_key === "string" && creds.api_key) ||
      process.env["FCC_RND_API_KEY"] ||
      "";
    return key || null;
  } catch {
    return process.env["FCC_RND_API_KEY"] || null;
  }
}

function isoDateDaysAgo(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toISOString().slice(0, 10);
}

/**
 * Check a 10-digit US phone number against the FCC Reassigned Numbers Database.
 *
 * @param phone    Exactly 10 digits, no country code (strip leading 1 before calling).
 * @param callDate ISO date string (YYYY-MM-DD) representing the consent date.
 *                 Defaults to DEFAULT_LOOKBACK_DAYS days ago.
 * @param firmId   Optional firm context for vault credential resolution.
 */
export async function checkFccRnd(
  phone: string,
  callDate?: string,
  firmId?: number,
): Promise<FccRndResult> {
  const key = await resolveKey(firmId);
  if (!key) return { status: "unconfigured" };

  const digits = phone.replace(/\D/g, "");
  // RND only covers US 10-digit numbers (strip leading 1 if present)
  const normalized = digits.length === 11 && digits.startsWith("1") ? digits.slice(1) : digits;
  if (normalized.length !== 10) {
    return { status: "invalid", phone: digits, note: "Phone must be a 10-digit US number" };
  }

  const effectiveCallDate = callDate ?? isoDateDaysAgo(DEFAULT_LOOKBACK_DAYS);
  const url =
    `${FCC_RND_BASE}?callDate=${encodeURIComponent(effectiveCallDate)}` +
    `&phoneNumber=${encodeURIComponent(normalized)}`;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FCC_RND_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: {
        "x-api-key": key,
        Accept: "application/json",
        "User-Agent": "mass-tort-os/bg-hub-phone",
      },
    });
    clearTimeout(timer);

    if (res.status === 401 || res.status === 403) {
      logger.warn({ status: res.status }, "bg-hub: FCC RND API key rejected");
      return {
        status: "unavailable",
        note: `FCC RND API key rejected (HTTP ${res.status}) — check vault configuration.`,
      };
    }

    if (res.status === 404) {
      // 404 means the number is not in the RND (non-US or never assigned).
      return {
        status: "invalid",
        phone: normalized,
        note: "Number not found in FCC RND — may be non-US, VoIP-only, or not yet in dataset.",
      };
    }

    if (!res.ok) {
      return {
        status: "unavailable",
        note: `FCC RND HTTP ${res.status}`,
      };
    }

    const data = (await res.json()) as {
      wasReassigned?: boolean;
      isActive?: boolean;
      lastAssignedDate?: string | null;
      phoneNumber?: string;
      error?: string;
    };

    if (typeof data.wasReassigned !== "boolean") {
      logger.warn({ data }, "bg-hub: FCC RND unexpected response shape");
      return {
        status: "unavailable",
        note: "FCC RND returned unexpected response shape — check API version.",
      };
    }

    if (data.wasReassigned) {
      return {
        status: "reassigned",
        phone: normalized,
        call_date: effectiveCallDate,
        last_assigned_date: data.lastAssignedDate ?? null,
        checked_at: new Date().toISOString(),
      };
    }

    return {
      status: "clean",
      phone: normalized,
      call_date: effectiveCallDate,
      checked_at: new Date().toISOString(),
    };
  } catch (err) {
    clearTimeout(timer);
    if ((err as { name?: string }).name === "AbortError") {
      return {
        status: "unavailable",
        note: `FCC RND timed out after ${FCC_RND_TIMEOUT_MS}ms`,
      };
    }
    logger.warn({ err }, "bg-hub: FCC RND fetch failed");
    return {
      status: "unavailable",
      note: `FCC RND network error: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}
