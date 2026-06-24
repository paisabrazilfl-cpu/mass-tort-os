/**
 * Inbound-call → tort resolution.
 *
 * The operator runs one dedicated phone number per tort/campaign. When a
 * caller dials that number, the agent must know which tort's intake "form"
 * (the tort's dedicated voice agent + capture schema) to run. Vapi
 * assistant metadata is not always present on inbound events, so we resolve
 * the tort from the strongest signal available, in priority order:
 *
 *   1. explicit `metadata.tort_id` on the call (set by our outbound dialer)
 *   2. the Vapi assistant id → tort_voice_agents.tort_id
 *   3. the DIALED (destination) number → tort_phone_numbers.tort_id
 *
 * The dialed-number lane is the operator-managed source of truth for
 * inbound and is what makes "one number per tort" work end to end.
 */
import { db, tortVoiceAgentsTable, tortPhoneNumbersTable } from "@workspace/db";
import { and, eq } from "drizzle-orm";
import { TORT_REGISTRY } from "../tort-engine";

/** Normalize a phone number to its last-10 digits for tolerant matching. */
function phone10(value: string | null | undefined): string | null {
  if (!value) return null;
  const digits = value.replace(/\D/g, "");
  return digits.length >= 10 ? digits.substring(Math.max(0, digits.length - 10)) : null;
}

/**
 * Look up the dedicated-number mapping for a dialed (destination) number.
 * Returns both the tort AND the firm that owns the number — the number is
 * the authoritative tenancy signal for inbound, so the firm it carries is
 * what scopes any lead dedup/creation (prevents cross-tenant attach).
 */
export async function findMappingForDialedNumber(
  dialedNumber: string | null | undefined,
): Promise<{ tortId: string; firmId: number | null } | null> {
  const target = phone10(dialedNumber);
  if (!target) return null;
  const rows = await db
    .select({
      phone_number: tortPhoneNumbersTable.phone_number,
      tort_id: tortPhoneNumbersTable.tort_id,
      firm_id: tortPhoneNumbersTable.firm_id,
    })
    .from(tortPhoneNumbersTable)
    .where(eq(tortPhoneNumbersTable.active, true));
  for (const r of rows) {
    if (phone10(r.phone_number) === target) return { tortId: r.tort_id, firmId: r.firm_id };
  }
  return null;
}

/**
 * Look up the dedicated-number mapping by the Vapi phone-number RESOURCE id.
 * Vapi inbound events sometimes carry only `phoneNumberId` (no dialed E.164),
 * so this is the second way to recover the tort + owning firm for tenancy.
 */
export async function findMappingForVapiNumberId(
  vapiNumberId: string | null | undefined,
): Promise<{ tortId: string; firmId: number | null } | null> {
  const id = (vapiNumberId ?? "").trim();
  if (!id) return null;
  const rows = await db
    .select({
      tort_id: tortPhoneNumbersTable.tort_id,
      firm_id: tortPhoneNumbersTable.firm_id,
    })
    .from(tortPhoneNumbersTable)
    .where(and(eq(tortPhoneNumbersTable.vapi_phone_number_id, id), eq(tortPhoneNumbersTable.active, true)))
    .limit(1);
  const r = rows[0];
  return r ? { tortId: r.tort_id, firmId: r.firm_id } : null;
}

/** Look up the tort that owns a Vapi assistant id, if any. */
export async function findTortForAssistant(
  assistantId: string | null | undefined,
): Promise<string | null> {
  if (!assistantId) return null;
  const rows = await db
    .select({ tort_id: tortVoiceAgentsTable.tort_id })
    .from(tortVoiceAgentsTable)
    .where(and(eq(tortVoiceAgentsTable.vapi_assistant_id, assistantId), eq(tortVoiceAgentsTable.status, "active")))
    .limit(1);
  return rows[0]?.tort_id ?? null;
}

export interface InboundTortSignals {
  metadataTortId?: string | null;
  assistantId?: string | null;
  dialedNumber?: string | null;
  /** Vapi phone-number resource id — used when the dialed E.164 is absent. */
  dialedNumberId?: string | null;
}

export interface InboundRouting {
  /** Resolved registry tort id, or null when nothing resolves. */
  tortId: string | null;
  /**
   * Firm that owns the dialed number, when resolution came from the
   * dedicated-number mapping. Null for the metadata/assistant lanes (those
   * carry no tenancy on their own). Used to scope inbound lead dedup so a
   * caller can never be attached to another firm's lead.
   */
  firmId: number | null;
}

/**
 * Resolve the tort (and, when available, the owning firm) for an inbound
 * call from the strongest available signal:
 *   1. explicit metadata.tort_id
 *   2. the Vapi assistant id
 *   3. the dialed (destination) number — also yields the firm
 */
export async function resolveInboundTort(signals: InboundTortSignals): Promise<InboundRouting> {
  // The dialed (destination) number is the authoritative tenancy signal for
  // inbound, so always resolve it up front — even when a stronger tort signal
  // (metadata/assistant) wins the tort itself. Otherwise a call whose tort
  // resolves via metadata/assistant would carry firmId=null and fall through
  // to GLOBAL lead dedup, which could attach the caller to another firm's
  // lead. Sourcing firm from the number keeps inbound dedup firm-scoped.
  const byNumber =
    (await findMappingForDialedNumber(signals.dialedNumber)) ??
    (await findMappingForVapiNumberId(signals.dialedNumberId));
  const numberFirmId = byNumber?.firmId ?? null;

  const meta = (signals.metadataTortId ?? "").trim();
  if (meta && TORT_REGISTRY[meta]) return { tortId: meta, firmId: numberFirmId };

  const byAssistant = await findTortForAssistant(signals.assistantId);
  if (byAssistant) return { tortId: byAssistant, firmId: numberFirmId };

  if (byNumber) return { tortId: byNumber.tortId, firmId: byNumber.firmId };

  return { tortId: null, firmId: null };
}
