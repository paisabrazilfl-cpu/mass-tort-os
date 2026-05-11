/**
 * Trigger dispatcher for automation workflows.
 *
 * RECURSIVE STATE MACHINE — dispatchTrigger implements:
 *   BOOT → POLLING (find matching workflows) → INPUT_DETECTED
 *   → RISK_CHECKING (max retry gate) → ACTING (runWorkflow)
 *   → VERIFYING (check result) → RESULT_CLASSIFYING
 *   → RECURSION_GATE (retry on transient fail, stop on success/max)
 *   → MEMORY_UPDATING (log outcome) → COMPLETE / HOLD / ABORT
 *
 * Retry rules:
 *   - Max 3 retries per workflow per trigger event
 *   - Exponential backoff: 1s, 2s, 4s
 *   - No retry on: validation errors, missing lead, permissions
 *   - Retry on: DB transient, timeout, external API 5xx
 *   - State persists in automation_runs for observability
 */
import { db, pool, automationWorkflowsTable } from "@workspace/db";
import { eq, and, isNull, or } from "drizzle-orm";
import { logger } from "../logger";
import { runWorkflow } from "./executor";

export interface DispatchOptions {
  input: Record<string, unknown>;
  firmId: number | null | "any";
  source: string;
  /** Override max retries (default 3) */
  maxRetries?: number;
}

const MAX_RETRIES = 3;
const BASE_BACKOFF_MS = 1000;

/** Classify whether an error is retryable */
function isRetryable(err: unknown): boolean {
  const msg = String(err).toLowerCase();
  // Never retry: validation, auth, missing resource
  if (msg.includes("not found") || msg.includes("validation") ||
      msg.includes("permission") || msg.includes("unauthorized")) return false;
  // Retry: transient DB, timeout, network, 5xx
  return msg.includes("timeout") || msg.includes("econnreset") ||
         msg.includes("enotfound") || msg.includes("503") ||
         msg.includes("502") || msg.includes("connection") ||
         msg.includes("pool") || msg.includes("transaction");
}

async function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function findWorkflows(
  triggerType: string,
  firmId: number | null | "any",
): Promise<Array<{ id: number; firm_id: number | null }>> {
  // Raw SQL path is retained for compatibility, but it MUST stay
  // parameterized. This function accepts trigger names from dispatcher
  // callers; string interpolation here would turn a malformed trigger into
  // SQL injection inside a privileged automation surface.
  try {
    const params: unknown[] = [triggerType];
    const where = ["enabled = true", "trigger_type = $1"];
    if (firmId !== "any" && firmId != null) {
      params.push(firmId);
      where.push(`(firm_id = $${params.length} OR firm_id IS NULL)`);
    } else if (firmId == null) {
      where.push("firm_id IS NULL");
    }
    const raw = await pool.query(
      `SELECT id, firm_id FROM automation_workflows WHERE ${where.join(" AND ")}`,
      params,
    );
    return raw.rows ?? [];
  } catch {
    // Fallback to Drizzle
    const baseWhere = [
      eq(automationWorkflowsTable.enabled, true),
      eq(automationWorkflowsTable.trigger_type, triggerType),
    ];
    if (firmId === "any") { /* no filter */ }
    else if (firmId == null) baseWhere.push(isNull(automationWorkflowsTable.firm_id));
    else baseWhere.push(or(eq(automationWorkflowsTable.firm_id, firmId), isNull(automationWorkflowsTable.firm_id))!);
    return await db.select({ id: automationWorkflowsTable.id, firm_id: automationWorkflowsTable.firm_id })
      .from(automationWorkflowsTable).where(and(...baseWhere));
  }
}

/**
 * Core recursive execution with retry + exponential backoff.
 * Implements the RECURSION_GATE from the BOS-OMEGA state machine spec.
 */
async function executeWithRetry(
  wf: { id: number; firm_id: number | null },
  opts: DispatchOptions,
): Promise<void> {
  const maxRetries = Math.max(1, Math.min(6, Math.floor(opts.maxRetries ?? MAX_RETRIES)));
  let lastError: unknown = null;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      // ACTING state
      const result = await runWorkflow({
        workflowId: wf.id,
        firmId: wf.firm_id,
        triggerSource: opts.source,
        input: opts.input,
      });

      // RESULT_CLASSIFYING
      if (result.status === "completed") {
        logger.info(
          { workflowId: wf.id, runId: result.runId, status: result.status, attempt },
          "dispatchTrigger: COMPLETE",
        );
        return;
      }

      lastError = new Error(result.error ?? `Workflow ${wf.id} failed with no error message`);
      const retryable = isRetryable(lastError);
      if (!retryable || attempt + 1 >= maxRetries) {
        logger.error(
          { err: String(lastError).slice(0, 200), workflowId: wf.id, runId: result.runId, attempt, retryable },
          "dispatchTrigger: ABORT — workflow run failed permanently",
        );
        return;
      }
    } catch (err: unknown) {
      lastError = err;
      const retryable = isRetryable(err);

      if (!retryable || attempt + 1 >= maxRetries) {
        logger.error(
          { err: String(err).slice(0, 200), workflowId: wf.id, attempt, retryable },
          "dispatchTrigger: ABORT — workflow run failed permanently",
        );
        return;
      }
    }

    // RECURSION_GATE:RETRY — bounded exponential backoff. Iterative by
    // design: recursive state semantics without stack growth or runaway loops.
    const backoff = BASE_BACKOFF_MS * Math.pow(2, attempt);
    logger.warn(
      { workflowId: wf.id, attempt, nextAttempt: attempt + 1, backoff, err: String(lastError).slice(0, 100) },
      "dispatchTrigger: RECURSION_GATE:RETRY — transient failure, backing off",
    );
    await sleep(backoff);
  }
}

/**
 * Main entry point — fire-and-forget with recursive retry per workflow.
 * Never throws; all errors are logged.
 */
export async function dispatchTrigger(
  triggerType: string,
  opts: DispatchOptions,
): Promise<void> {
  if (!triggerType.startsWith("trigger.")) {
    logger.warn({ triggerType }, "dispatchTrigger: invalid trigger type — ignoring");
    return;
  }

  let workflows: Array<{ id: number; firm_id: number | null }>;
  try {
    // POLLING state
    workflows = await findWorkflows(triggerType, opts.firmId);
  } catch (err) {
    logger.error({ err, triggerType }, "dispatchTrigger: POLLING failed — cannot query workflows");
    return;
  }

  if (workflows.length === 0) return;

  logger.info(
    { triggerType, source: opts.source, count: workflows.length },
    "dispatchTrigger: INPUT_DETECTED — dispatching to workflows",
  );

  // Fan out — each workflow gets its own recursive retry chain (fire-and-forget)
  for (const wf of workflows) {
    executeWithRetry(wf, opts).catch((err) => {
      logger.error({ err, workflowId: wf.id, triggerType }, "dispatchTrigger: uncaught error");
    });
  }
}

