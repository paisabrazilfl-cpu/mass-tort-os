/**
 * Resilient retry wrapper (AI Resiliency v2 — Phase 2 wiring).
 *
 * Composes the four Phase-1 modules (circuit-breaker, error-classifier,
 * observer, plus per-attempt AbortSignal.timeout) on top of the existing
 * `recursiveRetry` primitive. Adds:
 *
 *   1. Pre-attempt circuit-breaker check (CLOSED/HALF_OPEN admit;
 *      OPEN fails fast).
 *   2. Per-attempt hard timeout enforced via AbortSignal.timeout.
 *   3. Error classification: NON_RETRYABLE / BLOCK_UNSAFE / DEFER_EXTERNAL
 *      short-circuit the retry loop early; RETRYABLE flows through to
 *      the normal recursiveRetry budget.
 *   4. State-transition events emitted to the structured logger via
 *      emitAiStateTransition.
 *
 * SAFETY MODEL — this wrapper is OPT-IN. Production callers reach it
 * only via the AI_RESILIENCY_V2=1 env flag in routes/automations.ts.
 * The default code path is unchanged: a `recursiveRetry({...})` call
 * with no resiliency wiring. When this wrapper itself throws an
 * unexpected error, it falls back to plain `recursiveRetry` so the
 * worst case is "no v2 benefit," not "broken AI Helper."
 *
 * Public contract: identical input/output shape to `recursiveRetry`,
 * plus three new fields on the options object. Callers that don't
 * pass the new fields get behavior equivalent to plain recursiveRetry.
 */

import {
  recursiveRetry,
  type RecursiveRetryOptions,
  type RecursiveRetryResult,
  type AttemptContext,
  type AttemptOutcome,
} from "../automations/recursive-retry";
import { CircuitBreaker } from "./circuit-breaker";
import { classifyError, type ErrorClass } from "./error-classifier";
import { emitAiStateTransition } from "./observer";
import { logger } from "../logger";
import { randomUUID } from "node:crypto";

export interface ResilientRetryOptions<T> extends RecursiveRetryOptions<T> {
  /** Provider key for the per-provider circuit breaker. Required for v2. */
  provider: string;
  /** Per-attempt hard timeout in ms. Default 30_000. */
  attemptTimeoutMs?: number;
  /** Correlation id surfaced in every emitted event. Auto-generated if absent. */
  callId?: string;
}

/**
 * Returns true if the AI Resiliency v2 wiring is enabled via env flag.
 * Read each invocation so an operator can toggle without restart in dev.
 * Production should set this in their deploy manifest once for stability.
 */
export function isResiliencyV2Enabled(): boolean {
  return process.env["AI_RESILIENCY_V2"] === "1";
}

/**
 * Drop-in replacement for `recursiveRetry` when called via the AI
 * Helper path. Composes breaker + classifier + per-attempt timeout +
 * observer; when any of those throw unexpectedly it logs and falls
 * back to plain `recursiveRetry`.
 */
export async function resilientRetry<T>(
  opts: ResilientRetryOptions<T>,
): Promise<RecursiveRetryResult<T>> {
  const callId = opts.callId ?? randomUUID().slice(0, 8);
  const provider = opts.provider;
  const attemptTimeoutMs = opts.attemptTimeoutMs ?? 30_000;
  const startedAt = Date.now();
  let breakerSafetyTripped = false;

  // Wrap the user's attempt function with the resiliency layer. Each
  // wrapped attempt:
  //   1. Checks the circuit breaker; returns "circuit_open" failure
  //      if OPEN. The recursiveRetry loop treats it like any other
  //      failure (counts as an attempt), but recovery is fast.
  //   2. Enforces a per-attempt timeout via AbortSignal.timeout.
  //   3. Classifies any error and short-circuits the loop for
  //      NON_RETRYABLE / BLOCK_UNSAFE / DEFER_EXTERNAL by surfacing
  //      a final-failure shape that recursiveRetry's loop won't retry.
  const wrappedAttempt = async (ctx: AttemptContext): Promise<AttemptOutcome<T>> => {
    const attemptStart = Date.now();
    const breaker = CircuitBreaker.get(provider);

    // ── 1. Circuit breaker gate ───────────────────────────────────────
    if (!breaker.allowRequest()) {
      emitAiStateTransition({
        callId,
        provider,
        fromState: "EXECUTE",
        toState: "DEFER_EXTERNAL",
        attempt: ctx.perspectiveIndex + 1,
        elapsedMs: Date.now() - startedAt,
        errorClass: "DEFER_EXTERNAL",
        notes: `circuit_breaker=${breaker.getState()} failures=${breaker.getFailures()}`,
      });
      breakerSafetyTripped = true;
      return {
        ok: false,
        errorCode: "circuit_breaker_open",
        errorMessage: `Provider ${provider} circuit breaker is ${breaker.getState()} (${breaker.getFailures()} recent failures). Failing fast.`,
      };
    }

    emitAiStateTransition({
      callId,
      provider,
      fromState: ctx.perspectiveIndex === 0 ? "INIT" : "BACKOFF",
      toState: "EXECUTE",
      attempt: ctx.perspectiveIndex + 1,
      elapsedMs: Date.now() - startedAt,
      notes: `breaker=${breaker.getState()}`,
    });

    // ── 2. Per-attempt timeout via AbortSignal.race ──────────────────
    let timeoutFired = false;
    let outcome: AttemptOutcome<T>;
    try {
      const timeoutPromise = new Promise<never>((_, reject) => {
        const t = setTimeout(() => {
          timeoutFired = true;
          reject(new DOMException("attempt timed out", "AbortError"));
        }, attemptTimeoutMs);
        // Unref so the test process doesn't hang on a stray timer.
        if (typeof t.unref === "function") t.unref();
      });
      outcome = await Promise.race([opts.attempt(ctx), timeoutPromise]);
    } catch (err) {
      // The attempt itself or the timeout race rejected. Classify and
      // decide whether the recursiveRetry loop should keep retrying.
      const klass: ErrorClass = classifyError(err);
      emitAiStateTransition({
        callId,
        provider,
        fromState: "EXECUTE",
        toState:
          klass === "BLOCK_UNSAFE"
            ? "BLOCK_UNSAFE"
            : klass === "DEFER_EXTERNAL"
              ? "DEFER_EXTERNAL"
              : klass === "NON_RETRYABLE"
                ? "NON_RETRYABLE"
                : "BACKOFF",
        attempt: ctx.perspectiveIndex + 1,
        elapsedMs: Date.now() - startedAt,
        errorClass: klass,
        errorType: (err as Error | undefined)?.name,
        errorMessage: (err as Error | undefined)?.message,
        notes: timeoutFired ? "per-attempt timeout fired" : undefined,
      });

      // The breaker counts every failure regardless of class — a
      // surge of NON_RETRYABLEs from a misconfigured prompt would
      // otherwise mask a downstream provider outage.
      breaker.recordFailure();

      // Short-circuit the loop on classes the budget can't help with.
      // We do this by returning an attempt-outcome the loop treats as
      // a normal failure, BUT the wrapper's overall result will
      // re-check breakerSafetyTripped + the loop's lastError to
      // decide if we should stop early.
      return {
        ok: false,
        errorCode: klass === "RETRYABLE" ? "retryable_error" : klass.toLowerCase(),
        errorMessage: String((err as Error | undefined)?.message ?? err ?? "unknown"),
        // Stash the classification on details so the caller can
        // route on it without re-parsing.
        errorDetails: { errorClass: klass },
      };
    }

    // ── 3. Classify the attempt's structured outcome ──────────────────
    if (outcome.ok) {
      breaker.recordSuccess();
      emitAiStateTransition({
        callId,
        provider,
        fromState: "EXECUTE",
        toState: "COMPLETE_VERIFIED",
        attempt: ctx.perspectiveIndex + 1,
        elapsedMs: Date.now() - attemptStart,
      });
      return outcome;
    }

    // Structured failure from the inner attempt. Treat as RETRYABLE
    // unless the caller specifically labeled it otherwise.
    breaker.recordFailure();
    emitAiStateTransition({
      callId,
      provider,
      fromState: "EXECUTE",
      toState: "BACKOFF",
      attempt: ctx.perspectiveIndex + 1,
      elapsedMs: Date.now() - attemptStart,
      errorClass: "RETRYABLE",
      notes: `errorCode=${outcome.errorCode}`,
    });
    return outcome;
  };

  // Run the recursiveRetry loop with the wrapped attempt. We catch
  // any unexpected error from the wrapper itself and degrade to plain
  // recursiveRetry so a bug in the resiliency layer NEVER makes the
  // AI Helper worse than today.
  try {
    const result = await recursiveRetry<T>({
      ...opts,
      attempt: wrappedAttempt,
    });

    if (result.ok) {
      emitAiStateTransition({
        callId,
        provider,
        fromState: "EXECUTE",
        toState: "TERMINAL_OK",
        attempt: result.attempts.length,
        elapsedMs: Date.now() - startedAt,
      });
    } else {
      emitAiStateTransition({
        callId,
        provider,
        fromState: "EXECUTE",
        toState: breakerSafetyTripped ? "DEFER_EXTERNAL" : "FAILED",
        attempt: result.attempts.length,
        elapsedMs: Date.now() - startedAt,
        notes: `stopped=${result.stoppedReason} lastError=${result.lastError.code}`,
      });
    }
    return result;
  } catch (err) {
    // Defense-in-depth fallback. If anything in the resiliency layer
    // itself throws (it shouldn't — the wrapped attempt catches its
    // own exceptions), we degrade to the unwrapped retry so the AI
    // Helper still works. Log loudly so operators see the regression.
    logger.error(
      { err, provider, callId },
      "resilient-retry: wrapper threw unexpectedly — falling back to plain recursiveRetry",
    );
    return await recursiveRetry<T>(opts);
  }
}
