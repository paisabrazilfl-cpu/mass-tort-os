import crypto from "crypto";
import { logger } from "./logger";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;
const ENCODING = "base64" as const;

/**
 * Current encryption key version used for ALL new encrypts.
 * Decryption is version-aware and uses whatever version is embedded in the
 * ciphertext header ("enc:v<N>:...").
 *
 * Key rotation policy:
 *  - Bump this constant when introducing a new key.
 *  - Keep the OLD key available as ENCRYPTION_KEY_V<old> in Replit Secrets
 *    until every row has been re-encrypted by `scripts/rotate-encryption-key.ts`.
 *  - Once migration is verified, delete the old version's secret.
 *
 * Currently pinned to v1: the legacy `ENCRYPTION_KEY` secret IS the v1 key
 * (the resolver in `getKey()` accepts that name as the v1 fallback). Version 2
 * was never actually deployed — no row in the database is tagged `enc:v2:`,
 * and `ENCRYPTION_KEY_V2` was never provisioned. To roll forward to v2 in
 * the future, provision `ENCRYPTION_KEY_V2`, run the rotation script to
 * re-encrypt existing rows, then bump this constant.
 */
const CURRENT_KEY_VERSION = 1;

const HEX_64_RE = /^[0-9a-fA-F]{64}$/;

/**
 * Resolve the AES-256 key for a given version. Strict, no silent fallbacks
 * across versions (a missing v2 must NOT silently use v1, or you'd produce
 * v2-tagged ciphertext encrypted with the v1 key — undetectable disaster).
 *
 * Backward-compat: v1 also reads the legacy `ENCRYPTION_KEY` name, because
 * historical deployments stored the v1 key under that bare name (before
 * versioning existed). This is the ONLY cross-name fallback allowed.
 */
function getKey(version?: number): Buffer {
  const keyVersion = version ?? CURRENT_KEY_VERSION;
  const envName = `ENCRYPTION_KEY_V${keyVersion}`;
  let raw = process.env[envName];
  if (!raw && keyVersion === 1) {
    raw = process.env.ENCRYPTION_KEY;
  }
  if (!raw) {
    throw new Error(
      `${envName} environment variable is required (no key configured for encryption key version ${keyVersion})`,
    );
  }
  if (!HEX_64_RE.test(raw)) {
    throw new Error(
      `${envName} must be exactly 64 hex characters (32 bytes for AES-256-GCM); got ${raw.length} chars`,
    );
  }
  return Buffer.from(raw, "hex");
}

export function getCurrentKeyVersion(): number {
  return CURRENT_KEY_VERSION;
}

/** Test-only / migration-only: check whether a given version's key is configured. */
export function isKeyConfigured(version: number): boolean {
  try {
    getKey(version);
    return true;
  } catch {
    return false;
  }
}

function buildAAD(fieldName?: string, entityId?: string): Buffer | undefined {
  if (!fieldName) return undefined;
  const parts = [fieldName];
  if (entityId) parts.push(entityId);
  return Buffer.from(parts.join(":"), "utf8");
}

export function encrypt(
  plaintext: string,
  fieldName?: string,
  entityId?: string,
): string {
  if (!plaintext) return plaintext;
  const key = getKey(CURRENT_KEY_VERSION);
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv, {
    authTagLength: AUTH_TAG_LENGTH,
  });
  const aad = buildAAD(fieldName, entityId);
  if (aad) cipher.setAAD(aad);
  const encrypted = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();
  const combined = Buffer.concat([iv, authTag, encrypted]);
  const hasAAD = aad ? 1 : 0;
  return `enc:v${CURRENT_KEY_VERSION}:${hasAAD}:${combined.toString(ENCODING)}`;
}

/**
 * Try to decrypt with a specific AAD configuration. Returns null on failure.
 * Used by decrypt() to attempt multiple AAD variants for backward compatibility
 * when historical data was encrypted with a different (or no) AAD than what the
 * caller is now passing.
 */
function tryDecryptWithAAD(
  payload: string,
  keyVersion: number,
  aad: Buffer | undefined,
): string | null {
  try {
    const key = getKey(keyVersion);
    const combined = Buffer.from(payload, ENCODING);
    const iv = combined.subarray(0, IV_LENGTH);
    const authTag = combined.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH);
    const encrypted = combined.subarray(IV_LENGTH + AUTH_TAG_LENGTH);
    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv, {
      authTagLength: AUTH_TAG_LENGTH,
    });
    decipher.setAuthTag(authTag);
    if (aad) decipher.setAAD(aad);
    const decrypted = Buffer.concat([
      decipher.update(encrypted),
      decipher.final(),
    ]);
    return decrypted.toString("utf8");
  } catch {
    return null;
  }
}

export function decrypt(
  ciphertext: string,
  fieldName?: string,
  entityId?: string,
): string {
  if (!ciphertext) return ciphertext;
  // Cloudflare Worker compatibility: use charAt/substring instead of startsWith/slice
  if (
    ciphertext.charAt(0) !== "e" ||
    ciphertext.charAt(1) !== "n" ||
    ciphertext.charAt(2) !== "c" ||
    ciphertext.charAt(3) !== ":"
  ) {
    return ciphertext;
  }

  let keyVersion = 1;
  let hasAADFlag = 0;
  let payload: string;

  if (ciphertext.substring(0, 5) === "enc:v") {
    const parts = ciphertext.split(":");
    // parts[1] is "v<N>", extract N
    const vPart = parts[1] ?? "";
    keyVersion = parseInt(vPart.substring(1), 10) || 1;
    hasAADFlag = parseInt(parts[2] ?? "0", 10) || 0;
    payload = parts.slice(3).join(":");
  } else {
    payload = ciphertext.substring(4);
  }

  // Try the AAD configuration the ciphertext was tagged with first. If that
  // fails, fall back through other AAD variants — historical inconsistencies
  // (e.g. data encrypted before the entityId was known on insert) would
  // otherwise be permanently unrecoverable. AES-GCM auth tag verification
  // still prevents corruption: every fallback that succeeds is cryptographically
  // valid for the key + IV.
  const candidates: (Buffer | undefined)[] = [];
  if (hasAADFlag && fieldName) {
    candidates.push(buildAAD(fieldName, entityId)); // primary: field+entity
    candidates.push(buildAAD(fieldName, undefined)); // fallback: field only
  }
  candidates.push(undefined); // fallback: no AAD

  for (const aad of candidates) {
    const result = tryDecryptWithAAD(payload, keyVersion, aad);
    if (result !== null) return result;
  }

  logger.error(
    { fieldName, hasAAD: !!hasAADFlag, keyVersion },
    "Decryption failed — exhausted all AAD variants. Data may be corrupted or encryption key changed.",
  );
  return "[DECRYPTION_ERROR]";
}

export const ENCRYPTED_FIELDS = [
  "last_4_ssn",
  "date_of_birth",
  "diagnosis",
  "diagnosis_date",
  "street_address",
  "phone_primary",
  "phone",
  "medications",
  "notes",
  "physician_full_address",
  "physician_contact_info",
  "hospital_contact_info",
  "background_check_data",
] as const;

export function encryptLeadFields(
  data: Record<string, any>,
  entityId?: string,
): Record<string, any> {
  let result: Record<string, any> | undefined;
  for (const field of ENCRYPTED_FIELDS) {
    const val = data[field];
    if (val !== undefined && val !== null && typeof val === "string") {
      if (val.substring(0, 4) !== "enc:") {
        if (!result) result = { ...data };
        result[field] = encrypt(val, field, entityId);
      }
    }
  }
  return result ?? data;
}

export function decryptLeadFields(
  data: Record<string, any>,
  entityId?: string,
): Record<string, any> {
  if (!data) return data;
  let result: Record<string, any> | undefined;
  for (const field of ENCRYPTED_FIELDS) {
    const val = data[field];
    if (val !== undefined && val !== null && typeof val === "string") {
      const decrypted = decrypt(val, field, entityId);
      if (decrypted !== val) {
        if (!result) result = { ...data };
        result[field] = decrypted;
      }
    }
  }
  return result ?? data;
}

export function decryptLeadArray(
  leads: Record<string, any>[],
): Record<string, any>[] {
  return leads.map((l) => decryptLeadFields(l, String(l.id)));
}

/**
 * Task #8: post-insert rebind of AAD to the freshly-assigned lead.id.
 *
 * Lead inserts cannot pass `entityId` to `encryptLeadFields` because the
 * serial id is only known after `INSERT … RETURNING id`. Without rebind,
 * the AAD-tagged ciphertexts are bound to (fieldName) only, and a future
 * UPDATE on a different row can paste those bytes in without AES-GCM
 * detecting the swap.
 *
 * This helper takes the just-inserted row, re-encrypts every populated
 * encrypted field with `(fieldName, String(lead.id))` AAD, and writes
 * the rebound ciphertexts back. The decrypt-side AAD-fallback chain in
 * `decrypt()` makes this a no-op for already-bound rows and a one-shot
 * upgrade for legacy rows; either way, any subsequent decrypt with the
 * row's id verifies against the strict (field+entity) AAD first.
 */
export async function rebindLeadEncryptionAad(
  db: { update: (...args: any[]) => any },
  leadsTable: any,
  lead: Record<string, any>,
  eq: (col: any, val: any) => any,
): Promise<void> {
  if (!lead || lead.id === undefined || lead.id === null) return;
  const id = String(lead.id);
  const update: Record<string, any> = {};
  for (const field of ENCRYPTED_FIELDS) {
    const cur = lead[field];
    if (typeof cur !== "string" || !cur.startsWith("enc:")) continue;
    try {
      const plain = decrypt(cur, field, undefined);
      if (plain === "[DECRYPTION_ERROR]") continue;
      update[field] = encrypt(plain, field, id);
    } catch {
      // Skip individual field on rebind failure — the original ciphertext
      // remains intact and decrypt-side fallback still recovers it.
    }
  }
  if (Object.keys(update).length === 0) return;
  try {
    await db.update(leadsTable).set(update).where(eq(leadsTable.id, lead.id));
  } catch (err) {
    logger.warn(
      { err, leadId: lead.id },
      "rebindLeadEncryptionAad: post-insert rebind UPDATE failed",
    );
  }
}

export function hashForLookup(value: string): string {
  return crypto
    .createHmac("sha256", getKey())
    .update(value.toLowerCase().trim())
    .digest("hex");
}

export function reEncryptField(
  ciphertext: string,
  fieldName?: string,
  entityId?: string,
): string {
  const plain = decrypt(ciphertext, fieldName, entityId);
  if (plain === "[DECRYPTION_ERROR]") return ciphertext;
  return encrypt(plain, fieldName, entityId);
}
