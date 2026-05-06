/**
 * Re-export of the EmailAdapter contract so per-provider files don't have
 * to import directly from sendgrid.ts. The original interface declarations
 * still live in sendgrid.ts to preserve historical imports.
 */
export type {
  EmailAdapter,
  EmailSendRequest,
  EmailSendResult,
  EmailError,
  EmailSendOutcome,
} from "./sendgrid";
