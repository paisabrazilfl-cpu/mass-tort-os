// Recursive error-fallback loop with bounded perspective-shifting retries.
//
// Problem this solves: helper-LLM endpoints (today: /api/automations/assist;
// tomorrow: any other AI-driven planner) bail after one bad response. Asking
// the model to "try again with a 20% different angle, here's what went
// wrong" usually succeeds on attempt 2 or 3 — but only if we (a) feed the
// previous error back into the next attempt, and (b) guarantee we never
// loop forever.
//
// What "20% different perspective" means here is a CALLER concern: this
// module just sequences the attempts, supplies the previous error to the
// next attempt, and enforces the loop-safety caps. The caller decides how
// to perturb its prompt/inputs based on the `perspectiveIndex` we pass.
//
// Loop safety — three independent backstops, ANY of which terminates:
//   1. HARD ATTEMPT CAP — `maxAttempts` clamped to ABSOLUTE_MAX_ATTEMPTS=6.
//      No matter what a caller passes, we never run more than 6 attempts.
//   2. WALL-CLOCK CAP — `maxTotalMs` (default 30s). If cumulative time
//      across attempts exceeds this, we stop even mid-budget.
//   3. NO-PROGRESS CIRCUIT BREAKER — if two consecutive attempts fail
//      with the same `errorCode` AND the same sha256 of `errorMessage`,
//      we stop immediately. A different perspective producing the
//      identical failure means perturbation isn't helping; further
//      attempts waste tokens and time.
//
// Every attempt is logged with its perspective index, error (if any), and
// duration so the caller can return the full audit trail to the operator
// — "I tried 4 times with these perturbations, here's why each failed."
// That visibility is the difference between a useful self-healing loop
// and a black box that quietly burns LLM credits.

import { createHash } from "node:crypto";

/** Hard ceiling enforced regardless of caller input. */
export const ABSOLUTE_MAX_ATTEMPTS = 6;

/** Default total time budget across all attempts. */
export const DEFAULT_MAX_TOTAL_MS = 30_000;

/** Outcome of one attempt as reported by the caller's `attempt` fn. */
export type AttemptOutcome<T> =
  | { ok: true; value: T }
  | {
      ok: false;
      /** Short stable code, e.g. "invalid_json", "schema_mismatch". */
      errorCode: string;
      /** Operator-readable message. Used by the no-progress detector. */
      errorMessage: string;
      /** Optional structured detail to surface in the response. */
      errorDetails?: unknown;
    };

/** Context handed to each attempt. */
export interface AttemptContext {
  /** 0-indexed: 0 is the first try, 1 is the first retry, etc. */
  perspectiveIndex: number;
  /** Total attempts that will ever run (after clamping). Useful for the
   *  caller's "this is the last try" framing. */
  totalAttempts: number;
  /** The previous attempt's failure, or null on the first attempt. */
  previousError: { code: string; message: string; details?: unknown } | null;
}

/** Audit row recorded for every attempt (success or failure). */
export interface AttemptLog {
  perspectiveIndex: number;
  durationMs: number;
  ok: boolean;
  errorCode?: string;
  errorMessage?: string;
}

export type StoppedReason =
  | "succeeded"
  | "exhausted_attempts"
  | "exceeded_time_budget"
  | "no_progress_circuit_breaker";

export type RecursiveRetryResult<T> =
  | {
      ok: true;
      value: T;
      attempts: AttemptLog[];
      stoppedReason: "succeeded";
    }
  | {
      ok: false;
      lastError: { code: string; message: string; details?: unknown };
      attempts: AttemptLog[];
      stoppedReason: Exclude<StoppedReason, "succeeded">;
    };

export interface RecursiveRetryOptions<T> {
  /** Async function performing one attempt. Must return AttemptOutcome —
   *  it should NOT throw; throwing is treated as an "unknown_error"
   *  failure for resilience but callers are expected to catch internally
   *  and return a structured error so the perturbation prompt is useful. */
  attempt: (ctx: AttemptContext) => Promise<AttemptOutcome<T>>;
  /** Requested attempt count. Clamped to [1, ABSOLUTE_MAX_ATTEMPTS]. */
  maxAttempts?: number;
  /** Wall-clock budget across all attempts. Default 30 000 ms. */
  maxTotalMs?: number;
}

function hashMessage(s: string): string {
  return createHash("sha256").update(s).digest("hex").slice(0, 16);
}

/**
 * Run `attempt` up to `maxAttempts` times, feeding each retry the previous
 * failure so the caller can shift perspective. Stops as soon as any of
 * the three loop-safety backstops trips (or success). Always returns a
 * structured result with the full attempts log — never throws.
 */
export async function recursiveRetry<T>(
  opts: RecursiveRetryOptions<T>,
): Promise<RecursiveRetryResult<T>> {
  // Clamp attempt count to the hard ceiling. A caller passing 100 will
  // get 6; a caller passing 0 or a negative will get 1 (always at least
  // one attempt — otherwise this primitive does nothing).
  const requested = opts.maxAttempts ?? 4;
  const totalAttempts = Math.max(
    1,
    Math.min(ABSOLUTE_MAX_ATTEMPTS, Math.floor(requested)),
  );
  // Time budget is clamped to a 1ms floor — purely to avoid the
  // degenerate `0` / negative case that would make the pre-attempt
  // check trip immediately and return without ever calling `attempt`.
  // Callers wanting a very tight budget (e.g. tests, interactive
  // surfaces) can pass anything ≥ 1ms; there is no upper-end floor.
  const maxTotalMs = Math.max(1, opts.maxTotalMs ?? DEFAULT_MAX_TOTAL_MS);

  const startedAt = Date.now();
  const attempts: AttemptLog[] = [];
  let previousError: AttemptContext["previousError"] = null;
  // Track the last failure's signature for the no-progress detector.
  let lastSignature: string | null = null;
  let lastError: { code: string; message: string; details?: unknown } | null = null;

  for (let i = 0; i < totalAttempts; i++) {
    // Wall-clock check BEFORE the attempt so we don't kick off a fresh
    // expensive LLM call we know we can't honor.
    if (Date.now() - startedAt >= maxTotalMs) {
      return {
        ok: false,
        lastError: lastError ?? {
          code: "exceeded_time_budget",
          message: `Stopped before attempt ${i + 1}: ${maxTotalMs}ms budget exhausted.`,
        },
        attempts,
        stoppedReason: "exceeded_time_budget",
      };
    }

    const ctx: AttemptContext = {
      perspectiveIndex: i,
      totalAttempts,
      previousError,
    };

    const attemptStart = Date.now();
    let outcome: AttemptOutcome<T>;
    try {
      outcome = await opts.attempt(ctx);
    } catch (err: any) {
      // Defensive: callers SHOULD return structured failures, but if one
      // throws we treat it as a generic failure so the loop can continue
      // to the next perspective. Stack is not surfaced to operators.
      outcome = {
        ok: false,
        errorCode: "unknown_error",
        errorMessage: String(err?.message ?? err ?? "attempt threw"),
      };
    }
    const durationMs = Date.now() - attemptStart;

    if (outcome.ok) {
      attempts.push({ perspectiveIndex: i, durationMs, ok: true });
      return {
        ok: true,
        value: outcome.value,
        attempts,
        stoppedReason: "succeeded",
      };
    }

    attempts.push({
      perspectiveIndex: i,
      durationMs,
      ok: false,
      errorCode: outcome.errorCode,
      errorMessage: outcome.errorMessage,
    });
    lastError = {
      code: outcome.errorCode,
      message: outcome.errorMessage,
      details: outcome.errorDetails,
    };

    // No-progress detector: same errorCode + same message hash twice in
    // a row means the perspective shift produced the identical failure.
    // Bail rather than burn more attempts.
    const signature = `${outcome.errorCode}:${hashMessage(outcome.errorMessage)}`;
    if (lastSignature !== null && signature === lastSignature && i > 0) {
      return {
        ok: false,
        lastError,
        attempts,
        stoppedReason: "no_progress_circuit_breaker",
      };
    }
    lastSignature = signature;

    previousError = {
      code: outcome.errorCode,
      message: outcome.errorMessage,
      details: outcome.errorDetails,
    };
  }

  return {
    ok: false,
    lastError: lastError ?? {
      code: "exhausted_attempts",
      message: "All attempts failed without producing a structured error.",
    },
    attempts,
    stoppedReason: "exhausted_attempts",
  };
}

/**
 * Default perspective cues for AI-prompt callers. Each entry is appended
 * to the caller's prompt on attempt N (0-indexed). The caller is
 * responsible for actually splicing it into the system or user prompt;
 * this is just the canonical "20% shift" ladder so every consumer of
 * recursiveRetry frames retries the same way.
 *
 * The escalation is intentional: each step constrains the model more,
 * so by the last attempt it is producing a minimal solution rather than
 * generating yet another variation of the same failed approach.
 */
export const DEFAULT_PERSPECTIVE_CUES: readonly string[] = [
  // 0 — original, no perturbation.
  "",
  // 1 — first retry: gentle reframe.
  "RETRY (perspective shift ~20%): Your previous response failed validation. Re-read the previous error carefully, then take a slightly different angle — pick a different trigger if multiple apply, restructure branches, or relabel nodes. Do NOT repeat the exact same structure.",
  // 2 — second retry: simplify.
  "RETRY (perspective shift ~40%): Two attempts have failed. Reduce optional complexity: prefer fewer nodes, drop branching unless the user's request strictly requires it, and use the simplest trigger that fits.",
  // 3 — third retry: minimal viable.
  "RETRY (perspective shift ~60%): Three attempts have failed. Produce the MINIMUM viable graph that satisfies the user's request — one trigger, one to three action nodes, end. No branching, no scripts, no integrations beyond what is strictly named in the user's request.",
  // 4 — fourth retry: last-ditch literal.
  "RETRY (perspective shift ~80%): Final attempt. Treat the user's request literally and conservatively. If you are uncertain about a node type, prefer `utility.log` + `utility.end` over inventing structure. Echo the user's request in `explanation`.",
  // 5 — sixth attempt is the absolute ceiling; same framing as 4.
  "RETRY (perspective shift ~80%): Final attempt. Treat the user's request literally and conservatively. If you are uncertain about a node type, prefer `utility.log` + `utility.end` over inventing structure. Echo the user's request in `explanation`.",
];

/** Helper: pick the cue for a given perspective index, clamped to the
 *  array length so callers do not need to bounds-check. */
export function perspectiveCue(index: number): string {
  if (index <= 0) return DEFAULT_PERSPECTIVE_CUES[0];
  return (
    DEFAULT_PERSPECTIVE_CUES[
      Math.min(index, DEFAULT_PERSPECTIVE_CUES.length - 1)
    ] ?? ""
  );
}
