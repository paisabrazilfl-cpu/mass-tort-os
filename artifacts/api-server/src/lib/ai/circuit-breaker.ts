/**
 * Per-provider circuit breaker for LLM calls.
 *
 * PORTED FROM the Java reference at agent/CircuitBreaker.java with two
 * deliberate changes for TypeScript / Node:
 *   1. Per-provider singleton keyed by provider name (Java had one global)
 *      — so a misconfigured threshold on one provider can't cascade and
 *      starve the others. `CircuitBreaker.get("anthropic")` and
 *      `CircuitBreaker.get("openai")` are independent state machines.
 *   2. Failure-count + state in-process. In a multi-instance deployment
 *      (Render scales horizontally), each replica has its own counter.
 *      That's deliberate — making the breaker shared across replicas
 *      requires a Redis-ish coordination layer this codebase doesn't
 *      yet have. Per-replica is honest and still cuts blast radius
 *      proportionally.
 *
 * SHIPPING STATUS — Phase 1 of "AI resiliency v2":
 *   This module is present and tested but NOT WIRED into any production
 *   call path. `recursive-retry.ts`, `ai-provider.ts`, and every
 *   bg-hub adapter still run their existing logic. A future operator-
 *   reviewed commit wires it into callLLM behind the feature flag
 *   AI_RESILIENCY_V2=1.
 *
 *   Because nothing imports this module from a production path, this
 *   commit is provably safe: every existing test still passes, every
 *   request behaves identically to before. The diff against production
 *   behavior is a no-op until the wiring commit lands.
 *
 * State semantics:
 *   CLOSED    — calls flow normally
 *   OPEN      — fail-fast for callers; allowRequest() returns false
 *   HALF_OPEN — cooldown elapsed, one probe call permitted
 */

export type BreakerState = "CLOSED" | "OPEN" | "HALF_OPEN";

export interface CircuitBreakerOptions {
  /** Failures required to trip CLOSED → OPEN. Default 10. */
  failureThreshold?: number;
  /** Cooldown duration in OPEN before allowing a HALF_OPEN probe. Default 60s. */
  cooldownMs?: number;
}

export class CircuitBreaker {
  private static registry = new Map<string, CircuitBreaker>();

  /**
   * Resolve or lazily create the breaker for a given provider key.
   * Keys are arbitrary strings; conventionally the provider id
   * ("anthropic", "openai", "google_gemini"), but a caller can pass a
   * narrower key (e.g. "anthropic:drafting-ai") to separate counters
   * per module if a specific workload misbehaves more than others.
   */
  static get(key: string, opts?: CircuitBreakerOptions): CircuitBreaker {
    let breaker = CircuitBreaker.registry.get(key);
    if (!breaker) {
      breaker = new CircuitBreaker(key, opts);
      CircuitBreaker.registry.set(key, breaker);
    }
    return breaker;
  }

  /** Test-only: wipe the singleton registry between cases. */
  static __resetAll(): void {
    CircuitBreaker.registry.clear();
  }

  readonly key: string;
  private readonly failureThreshold: number;
  private readonly cooldownMs: number;

  private failures = 0;
  private state: BreakerState = "CLOSED";
  private openedAt: number | null = null;

  constructor(key: string, opts: CircuitBreakerOptions = {}) {
    this.key = key;
    this.failureThreshold = opts.failureThreshold ?? 10;
    this.cooldownMs = opts.cooldownMs ?? 60_000;
  }

  /**
   * Returns true if the caller is allowed to make the call. In OPEN
   * state, transitions to HALF_OPEN automatically once the cooldown
   * has elapsed and grants one probe request.
   */
  allowRequest(now: number = Date.now()): boolean {
    if (this.state === "CLOSED") return true;

    if (this.state === "OPEN") {
      if (this.openedAt !== null && now - this.openedAt >= this.cooldownMs) {
        // Cooldown elapsed — promote to HALF_OPEN and admit one probe.
        this.state = "HALF_OPEN";
        return true;
      }
      return false;
    }

    // HALF_OPEN — admit the probe (caller will record success or failure
    // and we'll decide whether to fully close or re-open).
    return true;
  }

  /** Record a successful call. Resets counters and closes the breaker. */
  recordSuccess(): void {
    this.failures = 0;
    this.state = "CLOSED";
    this.openedAt = null;
  }

  /**
   * Record a failed call. Trips CLOSED → OPEN on threshold. From
   * HALF_OPEN, any failure re-opens the breaker.
   */
  recordFailure(now: number = Date.now()): void {
    this.failures++;

    if (this.state === "HALF_OPEN") {
      this.openedAt = now;
      this.state = "OPEN";
      return;
    }

    if (this.failures >= this.failureThreshold && this.state === "CLOSED") {
      this.openedAt = now;
      this.state = "OPEN";
    }
  }

  /** Inspect the current state. For observability + tests. */
  getState(): BreakerState {
    return this.state;
  }

  getFailures(): number {
    return this.failures;
  }
}
