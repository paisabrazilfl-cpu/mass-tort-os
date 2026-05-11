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
  // Use raw pool.query to bypass Drizzle firmPredicate cache issues
  let where = `enabled = true AND trigger_type = '${triggerType}'`;
  if (firmId !== "any" && firmId != null) {
    where += ` AND (firm_id = ${firmId} OR firm_id IS NULL)`;
  } else if (firmId == null) {
    where += ` AND firm_id IS NULL`;
  }
  try {
    const raw = await pool.query(
      `SELECT id, firm_id FROM automation_workflows WHERE ${where}`
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
  attempt: number = 0,
): Promise<void> {
  const maxRetries = opts.maxRetries ?? MAX_RETRIES;

  // RECURSION_GATE — max iterations reached
  if (attempt >= maxRetries) {
    logger.warn(
      { workflowId: wf.id, attempt, maxRetries, source: opts.source },
      "dispatchTrigger: RECURSION_GATE:HOLD — max retries exhausted",
    );
    return;
  }

  try {
    // ACTING state
    const result = await runWorkflow({
      workflowId: wf.id,
      firmId: wf.firm_id,
      triggerSource: opts.source,
      input: opts.input,
    });

    // RESULT_CLASSIFYING
    if (result.status === "completed" || result.status === "failed") {
      // COMPLETE — terminal states don't retry
      logger.info(
        { workflowId: wf.id, runId: result.runId, status: result.status, attempt },
        "dispatchTrigger: COMPLETE",
      );
      return;
    }

    // Unexpected status — treat as retryable
    throw new Error(`Unexpected run status: ${result.status}`);

  } catch (err: unknown) {
    // RESULT_CLASSIFYING:FAILURE → RECURSION_GATE
    const retryable = isRetryable(err);

    if (!retryable || attempt + 1 >= maxRetries) {
      // ABORT — non-retryable or exhausted
      logger.error(
        { err: String(err).slice(0, 200), workflowId: wf.id, attempt, retryable },
        "dispatchTrigger: ABORT — workflow run failed permanently",
      );
      return;
    }

    // RECURSION_GATE:RETRY — backoff and recurse
    const backoff = BASE_BACKOFF_MS * Math.pow(2, attempt);
    logger.warn(
      { workflowId: wf.id, attempt, backoff, err: String(err).slice(0, 100) },
      "dispatchTrigger: RECURSION_GATE:RETRY — transient failure, backing off",
    );
    await sleep(backoff);
    return executeWithRetry(wf, opts, attempt + 1);
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
    executeWithRetry(wf, opts, 0).catch((err) => {
      logger.error({ err, workflowId: wf.id, triggerType }, "dispatchTrigger: uncaught error");
    });
  }
}
