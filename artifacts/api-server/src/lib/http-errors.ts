import type { Response } from "express";

/**
 * Unified API error envelope, identical in shape to the global error handler
 * in `app.ts`. Use these helpers from any route file so the CRM client only
 * has one error parser to maintain.
 *
 * Shape: `{ status: "error", code: string, message: string, details?: unknown }`
 *
 * `details` is reserved for structured field-level info (e.g. zod issues),
 * never for raw `err.message` — the global handler refuses to surface
 * `err.message` on 5xx because it can carry SQL fragments, file paths, or
 * PII. Server-side log the real error via `logger.error` instead.
 */
export function errorEnvelope(
  res: Response,
  status: number,
  code: string,
  message: string,
  details?: unknown,
): void {
  const body: Record<string, unknown> = { status: "error", code, message };
  if (details !== undefined) body.details = details;
  res.status(status).json(body);
}

export const badRequest = (res: Response, message: string, details?: unknown) =>
  errorEnvelope(res, 400, "bad_request", message, details);

export const unauthorized = (res: Response, message = "Unauthorized") =>
  errorEnvelope(res, 401, "unauthorized", message);

export const forbidden = (res: Response, message = "Forbidden") =>
  errorEnvelope(res, 403, "forbidden", message);

export const notFound = (res: Response, message = "Not found") =>
  errorEnvelope(res, 404, "not_found", message);

export const conflict = (res: Response, code: string, message: string) =>
  errorEnvelope(res, 409, code, message);

export const unprocessable = (res: Response, message: string, details?: unknown) =>
  errorEnvelope(res, 422, "unprocessable", message, details);

export const serverError = (res: Response, message = "Internal server error") =>
  errorEnvelope(res, 500, "internal_error", message);
