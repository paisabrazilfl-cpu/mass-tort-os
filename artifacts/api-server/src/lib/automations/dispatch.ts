/**
 * Trigger dispatcher for automation workflows.
 *
 * Internal callers (web-form submission, lead create, etc.) call
 * `dispatchTrigger("trigger.form_submitted", { input, firmId, source })` to
 * fan out into every enabled automation_workflows row whose entry node is
 * the given trigger type.
 *
 * Fire-and-forget — never blocks the caller. Each workflow run is recorded
 * in `automation_runs` so operators can inspect outcomes from the UI.
 */
import { db, automationWorkflowsTable } from "@workspace/db";
import { eq, and, isNull, or } from "drizzle-orm";
import { logger } from "../logger";
import { runWorkflow } from "./executor";

export interface DispatchOptions {
  /** Input passed to the trigger node (becomes `input` in handlers). */
  input: Record<string, unknown>;
  /**
   * Firm scope:
   *   - number → match workflows owned by that firm OR system-wide (firm_id IS NULL)
   *   - null   → match only system-wide (firm_id IS NULL) workflows
   *   - "any"  → match every enabled workflow of this trigger across all firms
   *              (use for tenant-less public events like web-form submissions
   *              where the lead has no firm context yet).
   */
  firmId: number | null | "any";
  /** Recorded on each run row for traceability. */
  source: string;
}

export async function dispatchTrigger(triggerType: string, opts: DispatchOptions): Promise<void> {
  if (!triggerType.startsWith("trigger.")) {
    logger.warn({ triggerType }, "dispatchTrigger called with non-trigger node type — ignoring");
    return;
  }
  let workflows: Array<{ id: number; firm_id: number | null }>;
  try {
    const baseWhere = [
      eq(automationWorkflowsTable.enabled, true),
      eq(automationWorkflowsTable.trigger_type, triggerType),
    ];
    if (opts.firmId === "any") {
      // No firm filter — every enabled workflow of this trigger runs.
    } else if (opts.firmId == null) {
      baseWhere.push(isNull(automationWorkflowsTable.firm_id));
    } else {
      baseWhere.push(
        or(eq(automationWorkflowsTable.firm_id, opts.firmId), isNull(automationWorkflowsTable.firm_id))!,
      );
    }
    workflows = await db
      .select({ id: automationWorkflowsTable.id, firm_id: automationWorkflowsTable.firm_id })
      .from(automationWorkflowsTable)
      .where(and(...baseWhere));
  } catch (err) {
    logger.error({ err, triggerType }, "dispatchTrigger: failed to query automation_workflows");
    return;
  }

  if (workflows.length === 0) return;

  for (const wf of workflows) {
    runWorkflow({
      workflowId: wf.id,
      firmId: wf.firm_id,
      triggerSource: opts.source,
      input: opts.input,
    }).catch((err) => {
      logger.error(
        { err, workflowId: wf.id, triggerType, source: opts.source },
        "dispatchTrigger: automation run failed",
      );
    });
  }
  logger.info(
    { triggerType, source: opts.source, count: workflows.length },
    "Dispatched trigger to automation workflows",
  );
}
