/**
 * Error classifier for LLM calls.
 *
 * PORTED FROM the Java reference at agent/ErrorClassifier.java. Same
 * four categories; TypeScript-specific error-shape detection.
 *
 * SHIPPING STATUS — same as circuit-breaker: standalone and tested,
 * not yet wired into any production call path. Available for the
 * follow-up resiliency-wiring commit.
 *
 * Categories
 * ----------
 * RETRYABLE       — transient: 429, 500-class, network error, timeout.
 *                   Caller should backoff and retry.
 * NON_RETRYABLE   — client-side bug: 400, 401, 403, 422. Retrying
 *                   without changing the request changes nothing.
 * DEFER_EXTERNAL  — upstream provider is explicitly unavailable
 *                   (provider-down signal). Stop locally; let a higher
 *                   layer (queue / fallback provider) take over.
 * BLOCK_UNSAFE    — security / policy violation. Refuse without retry,
 *                   without fallback, surface to operator.
 *
 * The classifier is conservative: anything it doesn't recognize falls
 * through to RETRYABLE. The cost of an extra retry on an unknown error
 * is bounded; the cost of refusing to retry a real transient error is
 * a lost lead.
 */

export type ErrorClass = "RETRYABLE" | "NON_RETRYABLE" | "DEFER_EXTERNAL" | "BLOCK_UNSAFE";

/**
 * Custom error class callers can throw to signal a provider-level
 * outage that should not be retried locally. The classifier sees this
 * and returns DEFER_EXTERNAL.
 */
export class ProviderUnavailableError extends Error {
  constructor(provider: string, public readonly statusCode?: number) {
    super(`Provider ${provider} is currently unavailable${statusCode ? ` (status ${statusCode})` : ""}`);
    this.name = "ProviderUnavailableError";
  }
}

/**
 * Custom error for policy / safety violations (AI Constitution
 * bright-line trip, prompt-injection detection, etc.). Surfaces as
 * BLOCK_UNSAFE — never retried, never fallback'd.
 */
export class PolicyViolationError extends Error {
  constructor(reason: string) {
    super(`Policy violation: ${reason}`);
    this.name = "PolicyViolationError";
  }
}

/**
 * Classify a thrown / returned error into one of the four buckets.
 * Accepts arbitrary unknown values defensively — many LLM SDKs reject
 * with plain objects or strings instead of Error instances.
 */
export function classifyError(err: unknown): ErrorClass {
  // Explicit policy violation — never retry.
  if (err instanceof PolicyViolationError) return "BLOCK_UNSAFE";

  // Explicit provider-down signal.
  if (err instanceof ProviderUnavailableError) return "DEFER_EXTERNAL";

  // Abort signal — caller's timeout fired. Caller decides whether to
  // retry; we report it as retryable so the budget-aware retry harness
  // can decide.
  if (err instanceof Error && err.name === "AbortError") return "RETRYABLE";

  // Network signals (checked BEFORE the TypeError branch). Node 18+ wraps
  // fetch network failures as `TypeError: fetch failed` with the real
  // cause attached as `err.cause` (UND_ERR_*, ENOTFOUND, ECONNREFUSED).
  // Treating that as NON_RETRYABLE based on the TypeError class alone
  // would refuse to retry transient DNS / TCP failures. Inspect the
  // message + cause chain first.
  const msg = readMessage(err).toLowerCase();
  const causeMsg = readCauseMessage(err).toLowerCase();
  if (/econnreset|enotfound|etimedout|econnrefused|socket hang up|fetch failed|network|und_err/.test(msg + " " + causeMsg)) {
    return "RETRYABLE";
  }

  // Real programmer error (after the network filter above eliminated the
  // fetch-failed false positive). Retrying same input changes nothing.
  if (err instanceof TypeError) return "NON_RETRYABLE";

  // Inspect status codes embedded in the error. LLM SDKs (Anthropic,
  // OpenAI, Google) all surface HTTP status either as `err.status`,
  // `err.statusCode`, or in the message.
  const status = readStatusCode(err);
  if (status !== null) {
    if (status === 401 || status === 403) return "NON_RETRYABLE"; // auth broken
    if (status === 400 || status === 422) return "NON_RETRYABLE"; // bad request
    if (status === 404) return "NON_RETRYABLE";
    if (status === 413) return "NON_RETRYABLE"; // payload too large
    if (status === 408) return "RETRYABLE"; // Request Timeout — backoff helps
    if (status === 425) return "RETRYABLE"; // Too Early — backoff helps
    if (status === 429) return "RETRYABLE"; // rate-limited — backoff helps
    if (status >= 500 && status < 600) return "RETRYABLE"; // server-side transient
  }

  if (/auth|unauthor|forbidden|api key|invalid_api_key/.test(msg)) {
    return "NON_RETRYABLE";
  }
  if (/policy|safety|content_policy|content-policy/.test(msg)) {
    return "BLOCK_UNSAFE";
  }

  // Default: assume transient. Cheaper to retry once than to surface
  // a permanent failure on a recoverable case.
  return "RETRYABLE";
}

function readCauseMessage(err: unknown): string {
  if (err && typeof err === "object" && "cause" in err) {
    return readMessage((err as { cause?: unknown }).cause);
  }
  return "";
}

function readStatusCode(err: unknown): number | null {
  if (err && typeof err === "object") {
    const e = err as { status?: unknown; statusCode?: unknown; response?: { status?: unknown } };
    const candidates = [e.status, e.statusCode, e.response?.status];
    for (const c of candidates) {
      if (typeof c === "number" && Number.isInteger(c) && c >= 100 && c < 600) return c;
    }
  }
  return null;
}

function readMessage(err: unknown): string {
  if (typeof err === "string") return err;
  if (err && typeof err === "object" && "message" in err) {
    const m = (err as { message?: unknown }).message;
    if (typeof m === "string") return m;
  }
  return String(err);
}
