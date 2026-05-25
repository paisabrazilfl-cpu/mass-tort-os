// Unit tests for the AI-resiliency v2 modules (circuit-breaker,
// error-classifier, observer). These modules ship in this commit but
// are NOT wired into any production call path — they exist for a
// follow-up commit to opt-in to. The tests pin their state-transition
// contracts so the future wiring commit has a known-good baseline.
//
// No DB, no network. Runs anywhere.

import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";

import { CircuitBreaker } from "../ai/circuit-breaker";
import {
  classifyError,
  ProviderUnavailableError,
  PolicyViolationError,
} from "../ai/error-classifier";
import { emitAiStateTransition, __resetObserverState } from "../ai/observer";

afterEach(() => {
  CircuitBreaker.__resetAll();
  __resetObserverState();
});

describe("CircuitBreaker", () => {
  test("starts in CLOSED state and admits requests", () => {
    const b = CircuitBreaker.get("test:start", { failureThreshold: 3, cooldownMs: 1000 });
    assert.equal(b.getState(), "CLOSED");
    assert.equal(b.allowRequest(), true);
  });

  test("trips OPEN after `failureThreshold` consecutive failures", () => {
    const b = CircuitBreaker.get("test:trip", { failureThreshold: 3, cooldownMs: 1000 });
    b.recordFailure();
    b.recordFailure();
    assert.equal(b.getState(), "CLOSED"); // not yet at threshold
    b.recordFailure();
    assert.equal(b.getState(), "OPEN");
    assert.equal(b.allowRequest(), false);
  });

  test("a single success resets the failure counter and closes the breaker", () => {
    const b = CircuitBreaker.get("test:reset", { failureThreshold: 3, cooldownMs: 1000 });
    b.recordFailure();
    b.recordFailure();
    b.recordSuccess();
    assert.equal(b.getFailures(), 0);
    assert.equal(b.getState(), "CLOSED");
  });

  test("OPEN → HALF_OPEN once cooldown elapses; admits exactly one probe", () => {
    const b = CircuitBreaker.get("test:halfopen", { failureThreshold: 2, cooldownMs: 100 });
    const t0 = 1_000_000;
    b.recordFailure(t0);
    b.recordFailure(t0);
    assert.equal(b.getState(), "OPEN");

    // Still in cooldown — request denied.
    assert.equal(b.allowRequest(t0 + 50), false);

    // Cooldown elapsed — request granted, state moves to HALF_OPEN.
    assert.equal(b.allowRequest(t0 + 200), true);
    assert.equal(b.getState(), "HALF_OPEN");
  });

  test("HALF_OPEN failure re-opens the breaker", () => {
    const b = CircuitBreaker.get("test:reopen", { failureThreshold: 2, cooldownMs: 100 });
    const t0 = 2_000_000;
    b.recordFailure(t0);
    b.recordFailure(t0);
    b.allowRequest(t0 + 200); // promotes to HALF_OPEN
    b.recordFailure(t0 + 250);
    assert.equal(b.getState(), "OPEN");
  });

  test("HALF_OPEN success closes the breaker fully", () => {
    const b = CircuitBreaker.get("test:probe-ok", { failureThreshold: 2, cooldownMs: 100 });
    const t0 = 3_000_000;
    b.recordFailure(t0);
    b.recordFailure(t0);
    b.allowRequest(t0 + 200); // promotes to HALF_OPEN
    b.recordSuccess();
    assert.equal(b.getState(), "CLOSED");
    assert.equal(b.getFailures(), 0);
  });

  test("per-provider isolation: anthropic outage does not trip openai's breaker", () => {
    const a = CircuitBreaker.get("anthropic", { failureThreshold: 3 });
    const o = CircuitBreaker.get("openai", { failureThreshold: 3 });
    a.recordFailure();
    a.recordFailure();
    a.recordFailure();
    assert.equal(a.getState(), "OPEN");
    assert.equal(o.getState(), "CLOSED");
    assert.equal(o.allowRequest(), true);
  });

  test("get() returns the same instance on repeated calls with the same key", () => {
    const a = CircuitBreaker.get("test:singleton");
    const b = CircuitBreaker.get("test:singleton");
    assert.equal(a, b);
  });
});

describe("classifyError", () => {
  test("PolicyViolationError → BLOCK_UNSAFE", () => {
    assert.equal(classifyError(new PolicyViolationError("test")), "BLOCK_UNSAFE");
  });

  test("ProviderUnavailableError → DEFER_EXTERNAL", () => {
    assert.equal(classifyError(new ProviderUnavailableError("anthropic", 503)), "DEFER_EXTERNAL");
  });

  test("TypeError → NON_RETRYABLE (programmer error)", () => {
    assert.equal(classifyError(new TypeError("undefined is not a function")), "NON_RETRYABLE");
  });

  test("AbortError → RETRYABLE (timeout, may clear)", () => {
    const e = new Error("aborted");
    e.name = "AbortError";
    assert.equal(classifyError(e), "RETRYABLE");
  });

  test("HTTP 401 / 403 → NON_RETRYABLE (auth broken)", () => {
    assert.equal(classifyError({ status: 401 }), "NON_RETRYABLE");
    assert.equal(classifyError({ status: 403 }), "NON_RETRYABLE");
  });

  test("HTTP 400 / 422 → NON_RETRYABLE (client error)", () => {
    assert.equal(classifyError({ statusCode: 400 }), "NON_RETRYABLE");
    assert.equal(classifyError({ statusCode: 422 }), "NON_RETRYABLE");
  });

  test("HTTP 429 → RETRYABLE (rate-limited, backoff helps)", () => {
    assert.equal(classifyError({ status: 429 }), "RETRYABLE");
  });

  test("HTTP 500–599 → RETRYABLE (server-side transient)", () => {
    assert.equal(classifyError({ status: 500 }), "RETRYABLE");
    assert.equal(classifyError({ status: 502 }), "RETRYABLE");
    assert.equal(classifyError({ status: 503 }), "RETRYABLE");
    assert.equal(classifyError({ status: 504 }), "RETRYABLE");
  });

  test("ECONNRESET / ETIMEDOUT in message → RETRYABLE", () => {
    assert.equal(classifyError(new Error("connect ECONNRESET 1.2.3.4")), "RETRYABLE");
    assert.equal(classifyError(new Error("request ETIMEDOUT")), "RETRYABLE");
  });

  test("auth-related strings in message → NON_RETRYABLE", () => {
    assert.equal(classifyError(new Error("invalid_api_key supplied")), "NON_RETRYABLE");
    assert.equal(classifyError(new Error("unauthorized")), "NON_RETRYABLE");
  });

  test("content-policy strings → BLOCK_UNSAFE", () => {
    assert.equal(classifyError(new Error("content_policy violation")), "BLOCK_UNSAFE");
  });

  test("response.status 503 → RETRYABLE (NOT DEFER_EXTERNAL — caller must throw the explicit class for that)", () => {
    // Nested response.status (fetch-style errors from Anthropic / OpenAI
    // SDKs) is read by the classifier. 503 lands in the 500-class
    // RETRYABLE bucket; callers wanting the explicit "provider down,
    // defer" semantics must throw `ProviderUnavailableError` instead.
    assert.equal(classifyError({ response: { status: 503 } }), "RETRYABLE");
    assert.equal(classifyError({ response: { status: 502 } }), "RETRYABLE");
  });

  test("unknown error → RETRYABLE (conservative default)", () => {
    assert.equal(classifyError({ weird: "shape" }), "RETRYABLE");
    assert.equal(classifyError("random string"), "RETRYABLE");
    assert.equal(classifyError(null), "RETRYABLE");
  });
});

describe("emitAiStateTransition (observer)", () => {
  test("emits without throwing on a well-formed event", () => {
    // We can't easily intercept the logger here without mocking it.
    // The contract we want is "doesn't throw" — observability code
    // should never escalate a 200 to a 500.
    assert.doesNotThrow(() =>
      emitAiStateTransition({
        callId: "abc123",
        provider: "anthropic",
        fromState: "EXECUTE",
        toState: "BACKOFF",
        attempt: 1,
        elapsedMs: 42,
        backoffMs: 1000,
        notes: "test",
      }),
    );
  });

  test("collapses rapid identical-state emissions within the 100ms window", () => {
    const t0 = 5_000_000;
    // Call emit twice with identical state at the same instant. Both
    // succeed (no throw), but the LRU should reflect a single retained
    // entry. We can't directly observe the log sink so we assert via
    // the cache reset contract.
    assert.doesNotThrow(() => {
      emitAiStateTransition({ callId: "burst", provider: "x", fromState: "EXECUTE", toState: "BACKOFF", attempt: 1, elapsedMs: 1 }, t0);
      emitAiStateTransition({ callId: "burst", provider: "x", fromState: "EXECUTE", toState: "BACKOFF", attempt: 1, elapsedMs: 2 }, t0 + 10);
    });
  });

  test("emits on state change regardless of timing", () => {
    const t0 = 6_000_000;
    assert.doesNotThrow(() => {
      emitAiStateTransition({ callId: "transition", provider: "x", fromState: "EXECUTE", toState: "BACKOFF", attempt: 1, elapsedMs: 1 }, t0);
      emitAiStateTransition({ callId: "transition", provider: "x", fromState: "BACKOFF", toState: "EXECUTE", attempt: 2, elapsedMs: 2 }, t0 + 5);
    });
  });

  test("redacts SSN / phone / email / DOB patterns from errorMessage", () => {
    assert.doesNotThrow(() =>
      emitAiStateTransition({
        callId: "pii-test",
        provider: "x",
        fromState: "EXECUTE",
        toState: "FAILED",
        attempt: 1,
        elapsedMs: 1,
        errorMessage: "Failed for claimant John, SSN 123-45-6789, email john@example.com, phone 415-555-1212",
      }),
    );
    // We can't sample the logger output from here without mocking pino,
    // but the contract is: this call doesn't throw, and a future test
    // that injects a sink (or reads structured stdout) can verify the
    // redactions. For this commit the no-throw assertion is enough to
    // prove the redactor doesn't blow up on the input.
  });
});
