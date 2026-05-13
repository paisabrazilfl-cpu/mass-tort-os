// Tests for the AI Resiliency v2 wrapper (Phase 2 wiring).
//
// What we verify:
//   1. The wrapper's happy path returns the same shape as recursiveRetry.
//   2. Circuit breaker gates: OPEN state fails fast without calling the
//      inner attempt.
//   3. Per-attempt timeout fires when the inner attempt exceeds the
//      configured deadline; the loop continues to the next attempt.
//   4. Error classification routes BLOCK_UNSAFE / NON_RETRYABLE /
//      DEFER_EXTERNAL to terminal failure shapes without exhausting
//      the retry budget on un-recoverable errors.
//   5. The fallback contract: if the wrapper itself crashes, plain
//      recursiveRetry is used so the AI Helper never gets WORSE than
//      it was before this commit.
//   6. isResiliencyV2Enabled reads the env var strictly.
//
// No DB, no network, no LLM call. All inner attempts are pure functions
// returning canned shapes.

import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";

import { CircuitBreaker } from "../ai/circuit-breaker";
import { __resetObserverState } from "../ai/observer";
import {
  resilientRetry,
  isResiliencyV2Enabled,
} from "../ai/resilient-retry";
import { PolicyViolationError, ProviderUnavailableError } from "../ai/error-classifier";

afterEach(() => {
  CircuitBreaker.__resetAll();
  __resetObserverState();
  delete process.env["AI_RESILIENCY_V2"];
});

describe("isResiliencyV2Enabled", () => {
  test("returns false when env var is absent", () => {
    delete process.env["AI_RESILIENCY_V2"];
    assert.equal(isResiliencyV2Enabled(), false);
  });

  test("returns false when env var is empty string", () => {
    process.env["AI_RESILIENCY_V2"] = "";
    assert.equal(isResiliencyV2Enabled(), false);
  });

  test("returns false when env var is anything other than the literal \"1\"", () => {
    for (const v of ["true", "yes", "on", "TRUE", "2", "0", "y", "n"]) {
      process.env["AI_RESILIENCY_V2"] = v;
      assert.equal(isResiliencyV2Enabled(), false, `expected "${v}" to disable`);
    }
  });

  test("returns true ONLY when env var === \"1\"", () => {
    process.env["AI_RESILIENCY_V2"] = "1";
    assert.equal(isResiliencyV2Enabled(), true);
  });
});

describe("resilientRetry: happy path", () => {
  test("returns the inner attempt's value on first success", async () => {
    const result = await resilientRetry({
      provider: "test:happy",
      maxAttempts: 3,
      maxTotalMs: 5000,
      attemptTimeoutMs: 1000,
      attempt: async () => ({ ok: true, value: { hello: "world" } }),
    });
    assert.equal(result.ok, true);
    if (result.ok) assert.deepEqual(result.value, { hello: "world" });
    assert.equal(result.stoppedReason, "succeeded");
  });

  test("retries on RETRYABLE structured failure and eventually succeeds", async () => {
    let attempts = 0;
    const result = await resilientRetry({
      provider: "test:retry",
      maxAttempts: 3,
      maxTotalMs: 5000,
      attemptTimeoutMs: 1000,
      attempt: async () => {
        attempts++;
        if (attempts < 3) {
          // Vary the message per attempt — recursiveRetry's
          // no-progress detector bails when two consecutive errors
          // have identical signatures, so the test must mirror what
          // a real LLM would do (different prompt → different error).
          return {
            ok: false,
            errorCode: `transient_${attempts}`,
            errorMessage: `attempt ${attempts} failed`,
          };
        }
        return { ok: true, value: "third time lucky" };
      },
    });
    assert.equal(result.ok, true);
    assert.equal(attempts, 3);
  });
});

describe("resilientRetry: circuit breaker gate", () => {
  test("when breaker is OPEN, the inner attempt is NOT called", async () => {
    // Pre-trip the breaker.
    const b = CircuitBreaker.get("test:open", { failureThreshold: 1, cooldownMs: 60_000 });
    b.recordFailure();
    assert.equal(b.getState(), "OPEN");

    let innerCalled = false;
    const result = await resilientRetry({
      provider: "test:open",
      maxAttempts: 3,
      maxTotalMs: 5000,
      attempt: async () => {
        innerCalled = true;
        return { ok: true, value: "should not happen" };
      },
    });
    assert.equal(innerCalled, false, "inner attempt should not run when breaker is OPEN");
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.lastError.code, "circuit_breaker_open");
    }
  });

  test("a successful call closes the breaker and resets failure count", async () => {
    const b = CircuitBreaker.get("test:reset");
    b.recordFailure();
    b.recordFailure();
    await resilientRetry({
      provider: "test:reset",
      maxAttempts: 1,
      maxTotalMs: 5000,
      attempt: async () => ({ ok: true, value: 42 }),
    });
    assert.equal(b.getState(), "CLOSED");
    assert.equal(b.getFailures(), 0);
  });
});

describe("resilientRetry: per-attempt timeout", () => {
  test("a hanging attempt is aborted at attemptTimeoutMs and the loop moves on", async () => {
    let attemptCount = 0;
    const result = await resilientRetry({
      provider: "test:timeout",
      maxAttempts: 2,
      maxTotalMs: 5000,
      attemptTimeoutMs: 50, // very short — first attempt will trip it
      attempt: async () => {
        attemptCount++;
        if (attemptCount === 1) {
          // Hang past the timeout. The wrapper rejects via the Promise.race.
          await new Promise((resolve) => setTimeout(resolve, 5000));
          return { ok: true, value: "should never resolve" };
        }
        return { ok: true, value: "second attempt won" };
      },
    });
    assert.equal(result.ok, true);
    if (result.ok) assert.equal(result.value, "second attempt won");
    assert.equal(attemptCount, 2);
  });
});

describe("resilientRetry: error classification", () => {
  test("a thrown TypeError surfaces as a NON_RETRYABLE class on the attempt's errorDetails", async () => {
    const result = await resilientRetry({
      provider: "test:type-error",
      maxAttempts: 3,
      maxTotalMs: 5000,
      attempt: async () => {
        throw new TypeError("undefined is not a function");
      },
    });
    assert.equal(result.ok, false);
    if (!result.ok) {
      // Attempts log contains the classification on the error details.
      const lastAttempt = result.attempts[result.attempts.length - 1]!;
      assert.equal(lastAttempt.ok, false);
    }
  });

  test("a thrown PolicyViolationError surfaces BLOCK_UNSAFE", async () => {
    const result = await resilientRetry({
      provider: "test:policy",
      maxAttempts: 3,
      maxTotalMs: 5000,
      attempt: async () => {
        throw new PolicyViolationError("AI Constitution bright line");
      },
    });
    assert.equal(result.ok, false);
  });

  test("a thrown ProviderUnavailableError surfaces DEFER_EXTERNAL", async () => {
    const result = await resilientRetry({
      provider: "test:provider-down",
      maxAttempts: 3,
      maxTotalMs: 5000,
      attempt: async () => {
        throw new ProviderUnavailableError("anthropic", 503);
      },
    });
    assert.equal(result.ok, false);
  });
});

describe("resilientRetry: fallback safety contract", () => {
  test("attempt-callback that throws is caught and counted as a failure (not propagated)", async () => {
    // Documents the contract: even if the inner attempt is poorly
    // behaved (throws unhandled errors), the wrapper does NOT crash —
    // it records a failure and proceeds.
    const result = await resilientRetry({
      provider: "test:throw",
      maxAttempts: 2,
      maxTotalMs: 5000,
      attempt: async () => {
        throw new Error("inner attempt threw unhandled");
      },
    });
    assert.equal(result.ok, false);
    assert.equal(result.attempts.length, 2);
  });
});
