import crypto from "crypto";
import { logger } from "./logger";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;
const ENCODING = "base64" as const;
const CURRENT_KEY_VERSION = 1;

function getKey(version?: number): Buffer {
  const keyVersion = version ?? CURRENT_KEY_VERSION;
  const envName = keyVersion === 1 ? "ENCRYPTION_KEY" : `ENCRYPTION_KEY_V${keyVersion}`;
  const key = process.env[envName] || process.env.ENCRYPTION_KEY;
  if (!key) {
    throw new Error(`${envName} environment variable is required`);
  }
  if (!/^[0-9a-fA-F]{64}$/.test(key)) {
    throw new Error(`${envName} must be exactly 64 hex characters (32 bytes for AES-256)`);
  }
  return Buffer.from(key, "hex");
}

function buildAAD(fieldName?: string, entityId?: string): Buffer | undefined {
  if (!fieldName) return undefined;
  const parts = [fieldName];
  if (entityId) parts.push(entityId);
  return Buffer.from(parts.join(":"), "utf8");
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

  if (ciphertext.startsWith("enc:v")) {
    const parts = ciphertext.split(":");
    keyVersion = parseInt(parts[1].slice(1), 10) || 1;
    hasAADFlag = parseInt(parts[2], 10) || 0;
    payload = parts.slice(3).join(":");
  } else {
    payload = ciphertext.slice(4);
  }

  // Try the AAD configuration the ciphertext was tagged with first. If that
  // fails, fall back through other AAD variants — historical inconsistencies
  // (e.g. data encrypted before the entityId was known on insert) would
  // otherwise be permanently unrecoverable. AES-GCM auth tag verification
  // still prevents corruption: every fallback that succeeds is cryptographically
  // valid for the key + IV.
  const candidates: (Buffer | undefined)[] = [];
  if (hasAADFlag && fieldName) {
    candidates.push(buildAAD(fieldName, entityId));      // primary: field+entity
    candidates.push(buildAAD(fieldName, undefined));     // fallback: field only
  }
  candidates.push(undefined);                             // fallback: no AAD

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

export function hashForLookup(value: string): string {
  return crypto.createHmac("sha256", getKey()).update(value.toLowerCase().trim()).digest("hex");
}

export function reEncryptField(ciphertext: string, fieldName?: string, entityId?: string): string {
  const plain = decrypt(ciphertext, fieldName, entityId);
  if (plain === "[DECRYPTION_ERROR]") return ciphertext;
  return encrypt(plain, fieldName, entityId);
}
