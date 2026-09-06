import crypto from "crypto";
import { performance } from "perf_hooks";
import { encryptLeadFields, decryptLeadArray } from "../encryption";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;
const ENCODING = "base64" as const;
const CURRENT_KEY_VERSION = 1;
const HEX_64_RE = /^[0-9a-fA-F]{64}$/;

process.env.ENCRYPTION_KEY_V1 = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

// --- Original Unoptimized Implementation ---
function originalGetKey(version?: number): Buffer {
  const keyVersion = version ?? CURRENT_KEY_VERSION;
  const envName = `ENCRYPTION_KEY_V${keyVersion}`;
  let raw = process.env[envName];
  if (!raw && keyVersion === 1) {
    raw = process.env.ENCRYPTION_KEY;
  }
  if (!raw) {
    throw new Error(`${envName} environment variable is required`);
  }
  if (!HEX_64_RE.test(raw)) {
    throw new Error(`${envName} must be exactly 64 hex characters`);
  }
  return Buffer.from(raw, "hex");
}

function originalBuildAAD(fieldName?: string, entityId?: string): Buffer | undefined {
  if (!fieldName) return undefined;
  const parts = [fieldName];
  if (entityId) parts.push(entityId);
  return Buffer.from(parts.join(":"), "utf8");
}

function originalTryDecryptWithAAD(
  payload: string,
  keyVersion: number,
  aad: Buffer | undefined,
): string | null {
  try {
    const key = originalGetKey(keyVersion);
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

function originalDecrypt(ciphertext: string, fieldName?: string, entityId?: string): string {
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

  const candidates: (Buffer | undefined)[] = [];
  if (hasAADFlag && fieldName) {
    candidates.push(originalBuildAAD(fieldName, entityId));
    candidates.push(originalBuildAAD(fieldName, undefined));
  }
  candidates.push(undefined);

  for (const aad of candidates) {
    const result = originalTryDecryptWithAAD(payload, keyVersion, aad);
    if (result !== null) return result;
  }

  return "[DECRYPTION_ERROR]";
}

function originalDecryptLeadFields(data: Record<string, any>, entityId?: string): Record<string, any> {
  if (!data) return data;
  const result = { ...data };
  const ENCRYPTED_FIELDS = [
    "last_4_ssn", "date_of_birth", "diagnosis", "diagnosis_date", "street_address",
    "phone_primary", "phone", "medications", "notes", "physician_full_address",
    "physician_contact_info", "hospital_contact_info", "background_check_data"
  ];
  for (const field of ENCRYPTED_FIELDS) {
    if (result[field] !== undefined && result[field] !== null && typeof result[field] === "string") {
      result[field] = originalDecrypt(result[field], field, entityId);
    }
  }
  return result;
}

function originalDecryptLeadArray(leads: Record<string, any>[]): Record<string, any>[] {
  return leads.map(l => originalDecryptLeadFields(l, String(l.id)));
}

async function runBenchmark() {
  const lead = {
    id: 123,
    last_4_ssn: "1234",
    date_of_birth: "1980-01-01",
    diagnosis: "Mesothelioma",
    diagnosis_date: "2020-05-10",
    street_address: "123 Main Street",
    phone_primary: "5551234567",
    phone: "5559876543",
    medications: "Aspirin",
    notes: "Patient states exposure at naval shipyard",
    physician_full_address: "100 Medical Center Way",
    physician_contact_info: "Dr. Smith 555-0000",
    hospital_contact_info: "General Hospital",
    background_check_data: "Clean",
  };

  const encryptedLead = encryptLeadFields(lead, "123");
  const batch = Array.from({ length: 100 }, () => ({ ...encryptedLead }));

  // Warmup
  for (let i = 0; i < 50; i++) {
    originalDecryptLeadArray(batch);
    decryptLeadArray(batch);
  }

  const iterations = 1000;

  // Baseline (original unoptimized implementation)
  const t0 = performance.now();
  for (let i = 0; i < iterations; i++) {
    originalDecryptLeadArray(batch);
  }
  const baselineTime = performance.now() - t0;

  // Optimized (from src/lib/encryption.ts)
  const t1 = performance.now();
  for (let i = 0; i < iterations; i++) {
    decryptLeadArray(batch);
  }
  const optimizedTime = performance.now() - t1;

  console.log(`--- AES-256-GCM Lead Decryption Benchmark ---`);
  console.log(`Iterations: ${iterations} batches of 100 leads (${iterations * 100} leads / ${iterations * 100 * 13} fields)`);
  console.log(`Original Baseline: ${baselineTime.toFixed(2)} ms (${(baselineTime / iterations).toFixed(3)} ms/batch)`);
  console.log(`Optimized Code:    ${optimizedTime.toFixed(2)} ms (${(optimizedTime / iterations).toFixed(3)} ms/batch)`);
  console.log(`Speedup:           ${(baselineTime / optimizedTime).toFixed(2)}x (${((1 - optimizedTime / baselineTime) * 100).toFixed(1)}% reduction)`);
}

runBenchmark();
