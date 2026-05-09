// Tests for the recursive error-fallback loop. The three loop-safety
// guarantees are the load-bearing contract; if any of these regress,
// /assist (and any other future consumer) could loop forever or burn
// LLM tokens on a hopeless retry — both of which would be much worse
// than the original "fail on first error" behaviour.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  recursiveRetry,
  perspectiveCue,
  ABSOLUTE_MAX_ATTEMPTS,
  DEFAULT_PERSPECTIVE_CUES,
  type AttemptContext,
  type AttemptOutcome,
} from "../recursive-retry";

describe("recursiveRetry", () => {
  test("succeeds on first attempt without retrying", async () => {
    let calls = 0;
    const result = await recursiveRetry<string>({
      attempt: async () => {
        calls++;
        return { ok: true, value: "fine" };
      },
      maxAttempts: 4,
    });
    assert.equal(calls, 1);
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.value, "fine");
      assert.equal(result.stoppedReason, "succeeded");
      assert.equal(result.attempts.length, 1);
      assert.equal(result.attempts[0].ok, true);
    }
  });

  test("recovers on retry — feeds previous error to next attempt", async () => {
    const seenContexts: AttemptContext[] = [];
    const result = await recursiveRetry<number>({
      attempt: async (ctx) => {
        seenContexts.push(ctx);
        if (ctx.perspectiveIndex === 0) {
          return { ok: false, errorCode: "first_fail", errorMessage: "no good" };
        }
        return { ok: true, value: 42 };
      },
      maxAttempts: 4,
    });
    assert.equal(result.ok, true);
    if (result.ok) assert.equal(result.value, 42);
    assert.equal(seenContexts.length, 2);
    // First attempt sees no previous error.
    assert.equal(seenContexts[0].previousError, null);
    // Second attempt sees the first attempt's error so the caller can
    // perturb its prompt with that context.
    assert.equal(seenContexts[1].previousError?.code, "first_fail");
    assert.equal(seenContexts[1].previousError?.message, "no good");
    assert.equal(seenContexts[1].perspectiveIndex, 1);
  });

  test("stops after maxAttempts when every attempt fails", async () => {
    let calls = 0;
    const result = await recursiveRetry<number>({
      attempt: async (ctx) => {
        calls++;
        // Vary the message so the no-progress detector does NOT fire —
        // we want to test the exhausted-attempts path specifically.
        return {
          ok: false,
          errorCode: "varied_fail",
          errorMessage: `attempt ${ctx.perspectiveIndex} failed`,
        };
      },
      maxAttempts: 3,
    });
    assert.equal(calls, 3);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.stoppedReason, "exhausted_attempts");
      assert.equal(result.attempts.length, 3);
      assert.equal(result.lastError.code, "varied_fail");
    }
  });

  test("clamps maxAttempts to ABSOLUTE_MAX_ATTEMPTS", async () => {
    let calls = 0;
    const result = await recursiveRetry<number>({
      attempt: async (ctx) => {
        calls++;
        return {
          ok: false,
          errorCode: "varied",
          errorMessage: `i=${ctx.perspectiveIndex}`,
        };
      },
      // Caller asks for 100 attempts. The hard ceiling MUST cap it.
      maxAttempts: 100,
    });
    assert.equal(calls, ABSOLUTE_MAX_ATTEMPTS);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.attempts.length, ABSOLUTE_MAX_ATTEMPTS);
  });

  test("clamps maxAttempts to a minimum of 1 (zero/negative becomes 1)", async () => {
    let calls = 0;
    await recursiveRetry<number>({
      attempt: async () => {
        calls++;
        return { ok: false, errorCode: "x", errorMessage: "x" };
      },
      maxAttempts: 0,
    });
    assert.equal(calls, 1, "0-attempt request still runs once — never 0 calls");
  });

  test("no-progress circuit breaker: identical failure twice → stop", async () => {
    let calls = 0;
    const result = await recursiveRetry<number>({
      attempt: async () => {
        calls++;
        // SAME code + SAME message every time → signature repeats
        // → breaker fires after attempt 2 (i.e. only 2 calls made).
        return {
          ok: false,
          errorCode: "stuck",
          errorMessage: "always the same failure",
        };
      },
      // Even though we asked for 6, the breaker must stop us at 2.
      maxAttempts: 6,
    });
    assert.equal(calls, 2);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.stoppedReason, "no_progress_circuit_breaker");
      assert.equal(result.attempts.length, 2);
    }
  });

  test("no-progress breaker does NOT fire when error code or message changes", async () => {
    let calls = 0;
    const result = await recursiveRetry<number>({
      attempt: async (ctx) => {
        calls++;
        // Distinct message each attempt → breaker should not fire.
        return {
          ok: false,
          errorCode: "varied",
          errorMessage: `attempt ${ctx.perspectiveIndex}`,
        };
      },
      maxAttempts: 4,
    });
    assert.equal(calls, 4);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.stoppedReason, "exhausted_attempts");
  });

  test("wall-clock budget terminates the loop even if attempts remain", async () => {
    let calls = 0;
    const result = await recursiveRetry<number>({
      attempt: async (ctx) => {
        calls++;
        // Each attempt sleeps 60ms; with a 100ms total budget we
        // should get at most 2 attempts before the pre-attempt check
        // bails out.
        await new Promise((r) => setTimeout(r, 60));
        return {
          ok: false,
          errorCode: "varied",
          errorMessage: `slow ${ctx.perspectiveIndex}`,
        };
      },
      maxAttempts: 6,
      maxTotalMs: 100,
    });
    assert.ok(calls >= 1 && calls <= 3, `expected 1-3 calls, got ${calls}`);
    assert.equal(result.ok, false);
    if (!result.ok) {
      // Either the time-budget check tripped, or attempts were
      // exhausted — both are valid early-stop reasons here. We
      // ASSERT it is one of the two safety paths (not "succeeded").
      assert.notEqual(result.stoppedReason, "succeeded");
    }
  });

  test("attempt fn that throws is treated as a failure (not propagated)", async () => {
    let calls = 0;
    const result = await recursiveRetry<number>({
      attempt: async () => {
        calls++;
        if (calls === 1) throw new Error("boom");
        return { ok: true, value: 7 };
      },
      maxAttempts: 4,
    });
    assert.equal(result.ok, true, "second attempt should succeed");
    assert.equal(calls, 2);
    if (result.ok) {
      assert.equal(result.attempts[0].ok, false);
      assert.equal(result.attempts[0].errorCode, "unknown_error");
      assert.match(result.attempts[0].errorMessage ?? "", /boom/);
    }
  });

  test("every attempt is logged with duration and outcome", async () => {
    const result = await recursiveRetry<string>({
      attempt: async (ctx) => {
        await new Promise((r) => setTimeout(r, 5));
        if (ctx.perspectiveIndex < 2) {
          return {
            ok: false,
            errorCode: "varied",
            errorMessage: `try ${ctx.perspectiveIndex}`,
          };
        }
        return { ok: true, value: "done" };
      },
      maxAttempts: 4,
    });
    assert.equal(result.ok, true);
    assert.equal(result.attempts.length, 3);
    for (const a of result.attempts) {
      assert.ok(a.durationMs >= 0);
      assert.equal(typeof a.perspectiveIndex, "number");
    }
  });
});

describe("perspectiveCue", () => {
  test("returns empty string for index 0 (original attempt)", () => {
    assert.equal(perspectiveCue(0), "");
    assert.equal(perspectiveCue(-1), "");
  });

  test("escalates wording across attempts 1..3", () => {
    const c1 = perspectiveCue(1);
    const c2 = perspectiveCue(2);
    const c3 = perspectiveCue(3);
    assert.match(c1, /20%/);
    assert.match(c2, /40%/);
    assert.match(c3, /60%/);
    // Each cue should explicitly reference RETRY so the model knows
    // it is a retry rather than the first request.
    for (const c of [c1, c2, c3]) assert.match(c, /^RETRY/);
  });

  test("clamps high indices to the last cue (no out-of-bounds)", () => {
    const last = DEFAULT_PERSPECTIVE_CUES[DEFAULT_PERSPECTIVE_CUES.length - 1];
    assert.equal(perspectiveCue(99), last);
    assert.equal(perspectiveCue(ABSOLUTE_MAX_ATTEMPTS + 5), last);
  });
});
