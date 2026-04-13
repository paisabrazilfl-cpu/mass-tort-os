import { auditLog } from "./audit";
import { logger } from "./logger";
import { db, reviewQueueTable } from "@workspace/db";
import type { SystemOutputState, FailsafeMode } from "./conflict-engine";

const MAX_RETRIES = 2;
const MAX_AI_RECHECKS = 1;
const MAX_RULE_RE_EVALUATIONS = 2;

export interface ExecutionLimits {
  max_retries: number;
  max_ai_rechecks: number;
  max_rule_re_evaluations: number;
}

export const DEFAULT_LIMITS: ExecutionLimits = {
  max_retries: MAX_RETRIES,
  max_ai_rechecks: MAX_AI_RECHECKS,
  max_rule_re_evaluations: MAX_RULE_RE_EVALUATIONS,
};

interface LoopState {
  retries: number;
  ai_rechecks: number;
  rule_re_evaluations: number;
}

interface FallbackContext {
  entity_type: string;
  entity_id: string;
  source_module: string;
  failsafe_mode?: FailsafeMode;
}

export interface FallbackResult<T> {
  success: boolean;
  output_state: SystemOutputState;
  data: T | null;
  error: string | null;
  retries_used: number;
  loop_aborted: boolean;
}

function sanitizeInput(input: Record<string, unknown>): Record<string, unknown> {
  const sanitized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (typeof value === "string") {
      sanitized[key] = value.trim().replace(/[^\x20-\x7E\u00C0-\u024F\u1E00-\u1EFF]/g, "");
    } else if (value === undefined) {
      sanitized[key] = null;
    } else {
      sanitized[key] = value;
    }
  }
  return sanitized;
}

export async function withErrorFallback<T>(
  fn: (input: Record<string, unknown>, attempt: number) => Promise<T>,
  input: Record<string, unknown>,
  ctx: FallbackContext,
  limits: ExecutionLimits = DEFAULT_LIMITS
): Promise<FallbackResult<T>> {
  const state: LoopState = { retries: 0, ai_rechecks: 0, rule_re_evaluations: 0 };
  let lastError: string | null = null;

  while (state.retries <= limits.max_retries) {
    try {
      const currentInput = state.retries === 0 ? input : sanitizeInput(input);
      const result = await fn(currentInput, state.retries);

      await auditLog(ctx.entity_type, ctx.entity_id, "execution_success", {
        source_module: ctx.source_module,
        attempt: state.retries + 1,
        sanitized: state.retries > 0,
      });

      return {
        success: true,
        output_state: "ACCEPT",
        data: result,
        error: null,
        retries_used: state.retries,
        loop_aborted: false,
      };
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      state.retries++;

      logger.error(
        { err, entity: ctx.entity_id, module: ctx.source_module, attempt: state.retries, max: limits.max_retries + 1 },
        "Execution failed — triggering fallback"
      );

      await auditLog(ctx.entity_type, ctx.entity_id, "execution_error", {
        source_module: ctx.source_module,
        error: lastError,
        attempt: state.retries,
        will_retry: state.retries <= limits.max_retries,
      });

      if (state.retries > limits.max_retries) {
        break;
      }

      logger.info(
        { entity: ctx.entity_id, attempt: state.retries },
        "Retrying with sanitized input"
      );
    }
  }

  logger.error(
    { entity: ctx.entity_id, module: ctx.source_module, retries: state.retries },
    "All retries exhausted — routing to REVIEW_REQUIRED"
  );

  const failsafe = ctx.failsafe_mode || "REVIEW_FAIL";
  const outputState: SystemOutputState = failsafe === "SAFE_FAIL" ? "REJECT" : "REVIEW_REQUIRED";

  await db.insert(reviewQueueTable).values({
    entity_type: ctx.entity_type,
    entity_id: ctx.entity_id,
    conflict_type: "EXECUTION_FAILURE",
    severity: "high",
    failsafe_mode: failsafe,
    source_module: ctx.source_module,
    summary: `Execution failed after ${state.retries} attempts: ${lastError}`,
    details: {
      error: lastError,
      retries_used: state.retries,
      output_state: outputState,
      original_input: input,
    },
    resolution: "pending",
    retry_count: state.retries,
  });

  await auditLog(ctx.entity_type, ctx.entity_id, "fallback_triggered", {
    source_module: ctx.source_module,
    failsafe_mode: failsafe,
    output_state: outputState,
    error: lastError,
    retries_exhausted: true,
  });

  return {
    success: false,
    output_state: outputState,
    data: null,
    error: lastError,
    retries_used: state.retries,
    loop_aborted: state.retries > limits.max_retries,
  };
}

export function createLoopGuard(limits: ExecutionLimits = DEFAULT_LIMITS) {
  const state: LoopState = { retries: 0, ai_rechecks: 0, rule_re_evaluations: 0 };

  return {
    canRetry(): boolean {
      return state.retries < limits.max_retries;
    },
    canAIRecheck(): boolean {
      return state.ai_rechecks < limits.max_ai_rechecks;
    },
    canReEvaluateRules(): boolean {
      return state.rule_re_evaluations < limits.max_rule_re_evaluations;
    },
    recordRetry(): void {
      state.retries++;
    },
    recordAIRecheck(): void {
      state.ai_rechecks++;
    },
    recordRuleReEvaluation(): void {
      state.rule_re_evaluations++;
    },
    isExhausted(): boolean {
      return (
        state.retries >= limits.max_retries &&
        state.ai_rechecks >= limits.max_ai_rechecks &&
        state.rule_re_evaluations >= limits.max_rule_re_evaluations
      );
    },
    getState(): LoopState & { loop_aborted: boolean } {
      return {
        ...state,
        loop_aborted:
          state.retries >= limits.max_retries ||
          state.ai_rechecks >= limits.max_ai_rechecks ||
          state.rule_re_evaluations >= limits.max_rule_re_evaluations,
      };
    },
  };
}
