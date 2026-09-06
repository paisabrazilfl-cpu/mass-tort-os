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
 * Module-level cache for resolved key Buffers keyed by version number.
 * Caching eliminates repeated process.env lookups, regex tests, and hex Buffer
 * allocations on every encryption/decryption call.
 */
const keyCacheMap = new Map<number, Buffer>();

/**
 * Clear the key cache. Used primarily in testing if process.env keys are mutated.
 */
export function clearKeyCache(): void {
  keyCacheMap.clear();
}

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
  const cached = keyCacheMap.get(keyVersion);
  if (cached) return cached;

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
  const keyBuf = Buffer.from(raw, "hex");
  keyCacheMap.set(keyVersion, keyBuf);
  return keyBuf;
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

/**
 * Fast-path AAD buffer builder avoiding array allocation and join overhead.
 */
function buildAAD(fieldName?: string, entityId?: string): Buffer | undefined {
  if (!fieldName) return undefined;
  if (!entityId) return Buffer.from(fieldName, "utf8");
  return Buffer.from(`${fieldName}:${entityId}`, "utf8");
}

export function encrypt(plaintext: string, fieldName?: string, entityId?: string): string {
  if (!plaintext) return plaintext;
  const key = getKey(CURRENT_KEY_VERSION);
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv, { authTagLength: AUTH_TAG_LENGTH });
  const aad = buildAAD(fieldName, entityId);
  if (aad) cipher.setAAD(aad);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  const combined = Buffer.concat([iv, authTag, encrypted]);
  const hasAAD = aad ? 1 : 0;
  return `enc:v${CURRENT_KEY_VERSION}:${hasAAD}:${combined.toString(ENCODING)}`;
}

/**
 * Try to decrypt with a pre-parsed payload Buffer and specific AAD configuration.
 * Returns null on failure.
 * Operating on the pre-parsed Buffer avoids repeating base64 decoding per candidate AAD variant.
 */
function tryDecryptWithBuffer(
  combined: Buffer,
  keyVersion: number,
  aad: Buffer | undefined,
): string | null {
  try {
    if (combined.length < IV_LENGTH + AUTH_TAG_LENGTH) return null;
    const key = getKey(keyVersion);
    const iv = combined.subarray(0, IV_LENGTH);
    const authTag = combined.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH);
    const encrypted = combined.subarray(IV_LENGTH + AUTH_TAG_LENGTH);
    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv, { authTagLength: AUTH_TAG_LENGTH });
    decipher.setAuthTag(authTag);
    if (aad) decipher.setAAD(aad);
    const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
    return decrypted.toString("utf8");
  } catch {
    return null;
  }
}

export function decrypt(ciphertext: string, fieldName?: string, entityId?: string): string {
  if (!ciphertext) return ciphertext;
  if (!ciphertext.startsWith("enc:")) return ciphertext;
  let keyVersion = 1;
  let hasAADFlag = 0;
  let payload: string;

  // Fast header parsing using indexOf to eliminate split/slice array allocations
  if (ciphertext.startsWith("enc:v")) {
    const idx1 = ciphertext.indexOf(":", 5);
    const idx2 = idx1 !== -1 ? ciphertext.indexOf(":", idx1 + 1) : -1;
    if (idx1 !== -1 && idx2 !== -1) {
      keyVersion = parseInt(ciphertext.slice(5, idx1), 10) || 1;
      hasAADFlag = parseInt(ciphertext.slice(idx1 + 1, idx2), 10) || 0;
      payload = ciphertext.slice(idx2 + 1);
    } else {
      payload = ciphertext.slice(4);
    }
  } else {
    payload = ciphertext.slice(4);
  }

  // Decode base64 payload to Buffer once before trying AAD candidate variants
  const combined = Buffer.from(payload, ENCODING);

  // Try the primary AAD configuration (field + entity) first, then fallback to (field only), then (no AAD)
  if (hasAADFlag && fieldName) {
    const res1 = tryDecryptWithBuffer(combined, keyVersion, buildAAD(fieldName, entityId));
    if (res1 !== null) return res1;
    const res2 = tryDecryptWithBuffer(combined, keyVersion, buildAAD(fieldName, undefined));
    if (res2 !== null) return res2;
  }

  const res3 = tryDecryptWithBuffer(combined, keyVersion, undefined);
  if (res3 !== null) return res3;

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

export function encryptLeadFields(data: Record<string, any>, entityId?: string): Record<string, any> {
  const result = { ...data };
  for (const field of ENCRYPTED_FIELDS) {
    if (result[field] !== undefined && result[field] !== null && typeof result[field] === "string") {
      if (!result[field].startsWith("enc:")) {
        result[field] = encrypt(result[field], field, entityId);
      }
    }
  }
  return result;
}

export function decryptLeadFields(data: Record<string, any>, entityId?: string): Record<string, any> {
  if (!data) return data;
  const result = { ...data };
  for (const field of ENCRYPTED_FIELDS) {
    if (result[field] !== undefined && result[field] !== null && typeof result[field] === "string") {
      result[field] = decrypt(result[field], field, entityId);
    }
  }
  return result;
}

export function decryptLeadArray(leads: Record<string, any>[]): Record<string, any>[] {
  return leads.map(l => decryptLeadFields(l, String(l.id)));
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
    logger.warn({ err, leadId: lead.id }, "rebindLeadEncryptionAad: post-insert rebind UPDATE failed");
  }
}

export function hashForLookup(value: string): string {
  return crypto.createHmac("sha256", getKey()).update(value.toLowerCase().trim()).digest("hex");
}

export function reEncryptField(ciphertext: string, fieldName?: string, entityId?: string): string {
  const plain = decrypt(ciphertext, fieldName, entityId);
  if (plain === "[DECRYPTION_ERROR]") return ciphertext;
  return encrypt(plain, fieldName, entityId);
}
