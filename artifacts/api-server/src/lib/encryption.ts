import crypto from "crypto";
import { logger } from "./logger";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;
const ENCODING = "base64" as const;

function getKey(): Buffer {
  const key = process.env.ENCRYPTION_KEY;
  if (!key) {
    throw new Error("ENCRYPTION_KEY environment variable is required");
  }
  if (!/^[0-9a-fA-F]{64}$/.test(key)) {
    throw new Error("ENCRYPTION_KEY must be exactly 64 hex characters (32 bytes for AES-256)");
  }
  return Buffer.from(key, "hex");
}

export function encrypt(plaintext: string): string {
  if (!plaintext) return plaintext;
  const key = getKey();
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv, { authTagLength: AUTH_TAG_LENGTH });
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  const combined = Buffer.concat([iv, authTag, encrypted]);
  return `enc:${combined.toString(ENCODING)}`;
}

export function decrypt(ciphertext: string): string {
  if (!ciphertext) return ciphertext;
  if (!ciphertext.startsWith("enc:")) return ciphertext;
  try {
    const key = getKey();
    const combined = Buffer.from(ciphertext.slice(4), ENCODING);
    const iv = combined.subarray(0, IV_LENGTH);
    const authTag = combined.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH);
    const encrypted = combined.subarray(IV_LENGTH + AUTH_TAG_LENGTH);
    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv, { authTagLength: AUTH_TAG_LENGTH });
    decipher.setAuthTag(authTag);
    const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
    return decrypted.toString("utf8");
  } catch {
    logger.error("Decryption failed — data may be corrupted or key mismatch");
    return "[DECRYPTION_ERROR]";
  }
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

export function encryptLeadFields(data: Record<string, any>): Record<string, any> {
  const result = { ...data };
  for (const field of ENCRYPTED_FIELDS) {
    if (result[field] !== undefined && result[field] !== null && typeof result[field] === "string") {
      if (!result[field].startsWith("enc:")) {
        result[field] = encrypt(result[field]);
      }
    }
  }
  return result;
}

export function decryptLeadFields(data: Record<string, any>): Record<string, any> {
  if (!data) return data;
  const result = { ...data };
  for (const field of ENCRYPTED_FIELDS) {
    if (result[field] !== undefined && result[field] !== null && typeof result[field] === "string") {
      result[field] = decrypt(result[field]);
    }
  }
  return result;
}

export function decryptLeadArray(leads: Record<string, any>[]): Record<string, any>[] {
  return leads.map(decryptLeadFields);
}

export function hashForLookup(value: string): string {
  return crypto.createHmac("sha256", getKey()).update(value.toLowerCase().trim()).digest("hex");
}
