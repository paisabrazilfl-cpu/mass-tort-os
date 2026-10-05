import { FAX_SOURCE_FILE_TEMPLATE } from "../fax-results-matcher.js";

const testCases = [
  "med_records_request_lead_987_env_env-uuid-deadbeef.pdf",
  "med_records_request_lead_5_env_abc_def-123.pdf",
  "med_records_request_lead_12345_env_01234567-89ab-cdef-0123-456789abcdef.pdf",
  "random.pdf",
  "med_records_request_lead_X_env_abc.pdf",
  "med_records_request_lead_0_env_abc.pdf",
  "med_records_request_lead_5_env_.pdf",
  null as any,
  undefined as any,
];

const ITERATIONS = 1_000_000;

function parseOriginal(sourceFile: string | null | undefined) {
  if (typeof sourceFile !== "string" || sourceFile.length === 0) return null;
  const match = sourceFile.match(/^med_records_request_lead_(\d+)_env_(.+)\.pdf$/);
  if (!match) return null;
  const leadId = Number(match[1]);
  if (!Number.isInteger(leadId) || leadId <= 0) return null;
  const envelopeId = match[2];
  if (!envelopeId || envelopeId.length === 0) return null;
  return { lead_id: leadId, envelope_id: envelopeId };
}

const FAX_FILE_RE = /^med_records_request_lead_([1-9]\d*)_env_(.+)\.pdf$/;

function parseHoistedRegex(sourceFile: string | null | undefined) {
  if (typeof sourceFile !== "string" || sourceFile.length < 36) return null;
  const match = FAX_FILE_RE.exec(sourceFile);
  if (!match) return null;
  return { lead_id: Number(match[1]), envelope_id: match[2] };
}

console.time("Original (per-call regex)");
for (let i = 0; i < ITERATIONS; i++) {
  for (const tc of testCases) {
    parseOriginal(tc);
  }
}
console.timeEnd("Original (per-call regex)");

console.time("Hoisted Regex with Length Guard");
for (let i = 0; i < ITERATIONS; i++) {
  for (const tc of testCases) {
    parseHoistedRegex(tc);
  }
}
console.timeEnd("Hoisted Regex with Length Guard");
