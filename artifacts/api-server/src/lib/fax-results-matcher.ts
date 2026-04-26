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
  if (typeof sourceFile !== "string" || sourceFile.length === 0) return null;
  const match = sourceFile.match(/^med_records_request_lead_(\d+)_env_(.+)\.pdf$/);
  if (!match) return null;
  const leadId = Number(match[1]);
  if (!Number.isInteger(leadId) || leadId <= 0) return null;
  const envelopeId = match[2];
  if (!envelopeId || envelopeId.length === 0) return null;
  return { lead_id: leadId, envelope_id: envelopeId };
}
