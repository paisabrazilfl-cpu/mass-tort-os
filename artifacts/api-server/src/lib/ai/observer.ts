/**
 * Structured state-transition events for the AI call resiliency layer.
 *
 * PORTED FROM the Java reference at agent/AgentObserver.java. TypeScript
 * version uses the existing project logger instead of java.util.logging.
 *
 * SHIPPING STATUS — same as circuit-breaker / error-classifier:
 * standalone, tested, not yet wired into a production call path.
 *
 * Contract: every state transition in the resiliency layer emits one
 * event via `emitAiStateTransition(...)`. Each event carries:
 *   - callId        : per-call correlation id (uuid prefix is fine)
 *   - provider      : LLM provider key (anthropic / openai / …)
 *   - fromState     : prior state in the resiliency machine
 *   - toState       : next state
 *   - attempt       : 1-indexed retry attempt
 *   - elapsedMs     : wall-clock ms since the call started
 *   - backoffMs     : sleep about to be performed (0 if not BACKOFF)
 *   - errorClass    : ErrorClass label, when applicable
 *   - errorType     : error constructor name
 *   - errorMessage  : redacted error message (≤200 chars)
 *   - notes         : free-text annotation
 *
 * PII / PHI hazard: the original Java code logs `error.getMessage()`
 * verbatim. LLM responses can echo claimant data, so we redact known
 * patterns (SSN, DOB, email, phone) AND truncate aggressively before
 * logging. The redactor is shared with the audit log so the rules stay
 * consistent — a leak through this path would already be flagged by
 * the audit-log redaction tests.
 *
 * Cost control: emitter is rate-limited per-callId to one event per
 * 100ms unless the toState changes. This stops a tight backoff loop
 * from flooding the log aggregator.
 */

import { logger } from "../logger";

export interface AiStateTransitionEvent {
  callId: string;
  provider: string;
  fromState: string;
  toState: string;
  attempt: number;
  elapsedMs: number;
  backoffMs?: number;
  errorClass?: string;
  errorType?: string;
  errorMessage?: string;
  notes?: string;
}

// Rate-limit table: callId → { lastEmitMs, lastToState }. Bounded to
// 1024 callIds via a tiny LRU so a long-running process doesn't grow
// unbounded; in practice the map churns through call ids in seconds.
const recent = new Map<string, { lastEmitMs: number; lastToState: string }>();
const LRU_MAX = 1024;
const COLLAPSE_WINDOW_MS = 100;

function shouldEmit(evt: AiStateTransitionEvent, now: number): boolean {
  const prev = recent.get(evt.callId);
  // Always emit on state change.
  if (!prev || prev.lastToState !== evt.toState) {
    return true;
  }
  // Same state within the collapse window → drop.
  return now - prev.lastEmitMs >= COLLAPSE_WINDOW_MS;
}

function remember(callId: string, toState: string, now: number): void {
  recent.set(callId, { lastEmitMs: now, lastToState: toState });
  if (recent.size > LRU_MAX) {
    // Evict the oldest insertion. Map iteration order is insertion order.
    const oldest = recent.keys().next().value;
    if (typeof oldest === "string") recent.delete(oldest);
  }
}

/** Test-only: clear the LRU between cases. */
export function __resetObserverState(): void {
  recent.clear();
}

/**
 * Redactor for error messages before they hit the log. Conservative:
 * masks anything that looks like SSN / phone / email / DOB. Caller
 * SHOULD still avoid passing raw lead data, but this is the
 * defense-in-depth net.
 */
function redactPii(s: string): string {
  if (!s) return "";
  return s
    .replace(/\b\d{3}-?\d{2}-?\d{4}\b/g, "[SSN]")
    .replace(/\b\d{3}[-.\s]?\d{3}[-.\s]?\d{4}\b/g, "[PHONE]")
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[EMAIL]")
    .replace(/\b\d{1,2}\/\d{1,2}\/\d{2,4}\b/g, "[DATE]")
    .replace(/\b\d{4}-\d{2}-\d{2}\b/g, "[DATE]")
    .slice(0, 200);
}

/**
 * Emit a state-transition event. Idempotent on rapid identical-state
 * repeats within the 100ms collapse window; always emits on state
 * change. The event goes to the structured logger; route it to your
 * preferred log aggregator (Datadog / OTel / etc) via the existing
 * pino transport setup.
 */
export function emitAiStateTransition(evt: AiStateTransitionEvent, now: number = Date.now()): void {
  if (!shouldEmit(evt, now)) return;
  remember(evt.callId, evt.toState, now);

  const payload: AiStateTransitionEvent = {
    ...evt,
    errorMessage: evt.errorMessage ? redactPii(evt.errorMessage) : undefined,
  };

  // Terminal failure-class transitions surface at warn or error so
  // log aggregators with severity routing trigger appropriately.
  if (
    evt.toState === "FAILED" ||
    evt.toState === "BLOCK_UNSAFE" ||
    evt.toState === "DEFER_EXTERNAL"
  ) {
    logger.error({ ai_event: payload }, `ai-resiliency: ${evt.fromState} → ${evt.toState}`);
  } else if (evt.toState === "BACKOFF" || evt.toState === "UNVERIFIED") {
    logger.warn({ ai_event: payload }, `ai-resiliency: ${evt.fromState} → ${evt.toState}`);
  } else {
    logger.info({ ai_event: payload }, `ai-resiliency: ${evt.fromState} → ${evt.toState}`);
  }
}
