// fax_results does not carry a lead_id column. When the workflow handler
// enqueues an outbound medical-records fax it tags the row's `source_file`
// with a stable convention so we can later associate fax results back to the
// originating lead and DocuSign envelope.
//
// Convention (see `workflow-handlers.ts` :: dispatchMedRecordsFax):
//   source_file = `med_records_request_lead_${lead_id}_env_${envelope_id}.pdf`
//
// This module centralises both halves of that contract: the SQL `LIKE`
// pattern used by `/api/leads/:id/fax-results` and the inverse parser used
// for matcher diagnostics. Keeping them together makes the convention
// auditable in one place and protects against drift between the producer
// (worker) and the consumer (read API).

const SOURCE_FILE_PREFIX = "med_records_request";

// Hoist regular expression to module scope to avoid re-compilation and per-call RegExp allocations.
// `[1-9]\d*` ensures lead_id is a positive non-zero integer directly in regex pattern matching.
const FAX_SOURCE_FILE_RE = /^med_records_request_lead_([1-9]\d*)_env_(.+)\.pdf$/;

// Minimum valid length: 25 ("med_records_request_lead_") + 1 (leadId) + 5 ("_env_") + 1 (envelopeId) + 4 (".pdf") = 36
const MIN_FAX_SOURCE_FILE_LEN = 36;

export const FAX_SOURCE_FILE_TEMPLATE = (leadId: number, envelopeId: number | string) =>
  `${SOURCE_FILE_PREFIX}_lead_${leadId}_env_${envelopeId}.pdf`;

/**
 * Build the SQL LIKE pattern that matches every fax_results.source_file
 * belonging to the given lead. Throws if the input is not a positive
 * finite integer (which would otherwise produce a pattern matching
 * unintended rows, e.g. `lead_NaN_` matching nothing or `lead_-1_`
 * accidentally matching `lead_-12_`).
 */
export function buildFaxResultsLikePattern(leadId: number): string {
  if (!Number.isInteger(leadId) || leadId <= 0) {
    throw new Error(`buildFaxResultsLikePattern: leadId must be a positive integer (got ${leadId})`);
  }
  return `${SOURCE_FILE_PREFIX}_lead_${leadId}_env_%`;
}

export interface ParsedFaxSourceFile {
  lead_id: number;
  envelope_id: string;
}

/**
 * Inverse of FAX_SOURCE_FILE_TEMPLATE. Returns null for source_file values
 * that don't follow the convention so callers can decide whether to skip
 * (legacy rows) or warn (drift). Tolerant of arbitrary envelope_id formats
 * (DocuSign uses UUIDs, but we allow any non-empty string).
 */
export function parseFaxSourceFile(sourceFile: string | null | undefined): ParsedFaxSourceFile | null {
  // Fast path: early return if input is not a string or too short to match pattern
  if (typeof sourceFile !== "string" || sourceFile.length < MIN_FAX_SOURCE_FILE_LEN) return null;

  const match = FAX_SOURCE_FILE_RE.exec(sourceFile);
  if (!match) return null;

  return {
    lead_id: Number(match[1]),
    envelope_id: match[2],
  };
}
