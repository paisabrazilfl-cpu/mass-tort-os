/**
 * MTOS Autonomous Agent — the embedded reasoning loop behind the `ai.agent`
 * automation node (Mode 2: in-process, workflow-scoped).
 *
 * The agent is given a GOAL and a set of TOOLS (each tool is one of the
 * other automation nodes, wrapped). It runs a bounded plan→act→observe loop:
 *
 *   1. The planner LLM (Bitdeer) emits a single JSON action or a final answer.
 *   2. The action names a tool + params; the executor invokes that node handler.
 *   3. The observation is fed back; the loop repeats until the agent finishes,
 *      the step cap is hit, or a guardrail trips.
 *
 * ENTERPRISE GUARDRAILS (all enforced here):
 *   - Step cap + wall-clock time budget — no runaway loop.
 *   - Repeated-action detector — an agent that calls the same tool with the
 *     same params 3× in a row is "stuck"; the run aborts instead of spinning.
 *   - Dry-run mode — write-classified tools are simulated, not executed, so an
 *     operator can watch the plan before trusting it. Read tools always run so
 *     the agent still observes real data.
 *   - Per-step audit — every tool call (and every simulated call) writes an
 *     audit_log row keyed entity_type="automation_agent".
 *   - Tenant scoping — the caller binds firm_id into every tool's StepContext;
 *     the agent cannot widen its own scope.
 *   - Parse-failure ceiling — 3 consecutive unparseable model replies abort.
 *
 * This module is import-clean of `@workspace/db` at load time: `auditLog` and
 * `callLLM` are imported lazily inside runAgent(), so the pure helpers
 * (parseAgentAction, classifyToolAccess) stay unit-testable without a database.
 */
import type { NodeParamSpec } from "./node-catalog";
import { logger } from "../logger";

// ── Tool access classification ──────────────────────────────────────────────

/**
 * Tools with no external side effect — pure compute, lookups, read-only
 * queries. These always execute, even in dry-run, so the agent can still see
 * real data and plan against it. Every node type NOT in this set is treated
 * as a "write" (the conservative default) and is simulated in dry-run.
 */
export const AGENT_READ_TOOLS: ReadonlySet<string> = new Set<string>([
  // data transforms — pure
  "data.set", "data.transform", "data.regex", "data.json_path", "data.csv_parse",
  // CRM lookups / scoring — no mutation
  "crm.npi_lookup", "crm.decision_engine", "crm.competitive_intel_lookup",
  "crm.background_check",
  // I/O reads
  "io.sql_query", "io.read_file",
  // search / AI compute — no mutation
  "integration.web_search",
  "ai.classify", "ai.rerank", "ai.summarize", "ai.draft", "ai.extract_fields",
  "ai.chat_response", "ai.transcribe",
  "documents.medical_extract", "documents.ocr_extract",
  // form inspection — no mutation
  "forms.embed_script", "forms.validate_submission",
  // diagnostics
  "utility.log",
]);

export function classifyToolAccess(type: string): "read" | "write" {
  return AGENT_READ_TOOLS.has(type) ? "read" : "write";
}

// ── Public types ────────────────────────────────────────────────────────────

export interface AgentTool {
  type: string;
  label: string;
  description: string;
  params: NodeParamSpec[];
  access: "read" | "write";
  /** Invoke the underlying node handler. Resolves to a normalized observation. */
  invoke(params: Record<string, unknown>): Promise<unknown>;
}

export interface AgentRunOptions {
  goal: string;
  tools: AgentTool[];
  maxSteps: number;
  /** Explicit Bitdeer model string. Falls through to the planner role. */
  model?: string;
  dryRun: boolean;
  timeBudgetMs: number;
  /** The workflow input — the agent's read-only view of "the situation". */
  context: Record<string, unknown>;
  runId: number;
  workflowId: number;
  firmId: number | null;
}

export interface AgentStep {
  step: number;
  thought: string;
  tool?: string;
  params?: Record<string, unknown>;
  access?: "read" | "write";
  simulated?: boolean;
  observation?: unknown;
  error?: string;
}

export interface AgentResult {
  status: "success" | "max_steps" | "error";
  summary: string;
  result?: unknown;
  steps: AgentStep[];
  stepsRun: number;
  stopReason: string;
  dryRun: boolean;
  error?: string;
}

// ── Action parsing — pure, unit-testable ────────────────────────────────────

export type ParsedAction =
  | { ok: true; kind: "action"; thought: string; tool: string; params: Record<string, unknown> }
  | { ok: true; kind: "final"; thought: string; summary: string; result: unknown }
  | { ok: false; error: string };

/**
 * Parse one planner reply into a structured action or final answer.
 *
 * LLMs are inconsistent: they wrap JSON in markdown fences, add prose, or
 * flatten the schema. This parser is deliberately permissive — it strips
 * fences, extracts the outermost JSON object, and accepts several common
 * shapes — but never guesses: an unrecognized shape returns ok:false so the
 * loop can nudge the model rather than silently mis-step.
 */
export function parseAgentAction(raw: string): ParsedAction {
  if (typeof raw !== "string" || raw.trim() === "") {
    return { ok: false, error: "empty model reply" };
  }
  let text = raw.trim();
  // Strip a leading ```json / ``` fence and a trailing ``` fence.
  text = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
  // Extract the outermost {...} so trailing/leading prose is tolerated.
  const first = text.indexOf("{");
  const last = text.lastIndexOf("}");
  if (first === -1 || last <= first) {
    return { ok: false, error: "no JSON object found in reply" };
  }
  let obj: any;
  try {
    obj = JSON.parse(text.slice(first, last + 1));
  } catch (err) {
    return { ok: false, error: `JSON parse failed: ${(err as Error).message}` };
  }
  if (!obj || typeof obj !== "object") {
    return { ok: false, error: "parsed value is not an object" };
  }

  const thought = String(obj.thought ?? obj.reasoning ?? obj.rationale ?? "").trim();

  // ── Final answer — several accepted shapes.
  const finalRaw =
    obj.final ?? obj.final_answer ?? obj.finalAnswer ?? (obj.status === "final" ? obj : undefined);
  if (finalRaw !== undefined && finalRaw !== null) {
    if (typeof finalRaw === "string") {
      return { ok: true, kind: "final", thought, summary: finalRaw.trim(), result: null };
    }
    if (typeof finalRaw === "object") {
      const summary = String(
        (finalRaw as any).summary ?? (finalRaw as any).message ?? obj.summary ?? "",
      ).trim();
      const result = (finalRaw as any).result ?? (finalRaw as any).output ?? finalRaw;
      return { ok: true, kind: "final", thought, summary: summary || "(no summary)", result };
    }
  }
  if (obj.done === true) {
    return {
      ok: true,
      kind: "final",
      thought,
      summary: String(obj.summary ?? "done").trim(),
      result: obj.result ?? null,
    };
  }

  // ── Tool action — { action: { tool, params } } or flattened { tool, params }.
  const actionRaw = obj.action ?? obj;
  const toolName =
    actionRaw && typeof actionRaw === "object"
      ? (actionRaw as any).tool ?? (actionRaw as any).name ?? (actionRaw as any).tool_name
      : undefined;
  if (typeof toolName === "string" && toolName.trim() !== "") {
    const paramsRaw =
      (actionRaw as any).params ?? (actionRaw as any).input ?? (actionRaw as any).arguments ?? {};
    const params =
      paramsRaw && typeof paramsRaw === "object" && !Array.isArray(paramsRaw)
        ? (paramsRaw as Record<string, unknown>)
        : {};
    return { ok: true, kind: "action", thought, tool: toolName.trim(), params };
  }

  return { ok: false, error: "reply had neither a recognizable action nor a final answer" };
}

// ── Internal helpers ────────────────────────────────────────────────────────

const OBSERVATION_CHAR_CAP = 3500;
const TRANSCRIPT_OBS_CAP = 1500;
const MAX_PARSE_FAILURES = 3;
const STUCK_REPEAT_THRESHOLD = 3;
const PLANNER_MAX_TOKENS = 1000;

/** Cap a value's serialized size so a chatty tool can't bloat the run row. */
function cap(value: unknown, limit: number): unknown {
  let s: string;
  try {
    s = JSON.stringify(value);
  } catch {
    return { _unserializable: true };
  }
  if (s == null) return value;
  if (s.length <= limit) return value;
  return { _truncated: true, length: s.length, preview: s.slice(0, limit) };
}

function paramsKey(tool: string | undefined, params: Record<string, unknown> | undefined): string {
  try {
    return `${tool}:${JSON.stringify(params ?? {})}`;
  } catch {
    return `${tool}:[unserializable]`;
  }
}

/** Count how many of the immediately-preceding steps repeat this exact call. */
function countTrailingRepeats(steps: AgentStep[], key: string): number {
  let n = 0;
  for (let i = steps.length - 1; i >= 0; i--) {
    if (paramsKey(steps[i]!.tool, steps[i]!.params) === key) n++;
    else break;
  }
  return n;
}

function renderParamSpec(p: NodeParamSpec): string {
  const flags = p.required ? ",required" : "";
  return `${p.key}(${p.type}${flags})`;
}

function buildSystemPrompt(opts: AgentRunOptions): string {
  const toolLines = opts.tools.map((t) => {
    const ps = t.params.length > 0 ? ` params: ${t.params.map(renderParamSpec).join(", ")}` : " params: none";
    return `- ${t.type} [${t.access}] — ${t.description}${ps}`;
  });
  const dryRunClause = opts.dryRun
    ? "\n- DRY-RUN MODE IS ON: write tools are SIMULATED, not executed. Their observations are marked simulated:true. Plan as if they succeeded, but do not rely on real-world effects."
    : "";
  return [
    "You are the MTOS Autonomous Agent, an AI operator embedded inside a mass-tort legal CRM.",
    "You accomplish a GOAL by calling tools one at a time and observing each result.",
    "",
    "PROTOCOL — every reply MUST be a single JSON object and nothing else. No markdown, no prose outside the JSON.",
    "",
    "To call a tool:",
    '  {"thought":"<why this step>","action":{"tool":"<tool.type>","params":{<key>:<value>}}}',
    "",
    "To finish (goal achieved, or proven impossible):",
    '  {"thought":"<why you are stopping>","final":{"summary":"<plain-language outcome>","result":{<structured result>}}}',
    "",
    "RULES:",
    "- Exactly ONE tool call per reply, OR a final answer. Never both, never none.",
    "- Use concrete values you have discovered. You MAY reference the original workflow input with strings like \"input.lead.id\".",
    "- Inspect before you mutate: run read/query tools first, then write tools.",
    "- If a tool returns an error, adapt your approach — do NOT repeat the identical call.",
    "- Finish as soon as the goal is met. If it cannot be met, finish with a summary explaining why.",
    `- You have at most ${opts.maxSteps} steps.${dryRunClause}`,
    "",
    "AVAILABLE TOOLS:",
    ...toolLines,
  ].join("\n");
}

function buildTurnPrompt(opts: AgentRunOptions, transcript: string[]): string {
  const ctx = cap(opts.context, 3000);
  const parts = [
    `GOAL:\n${opts.goal}`,
    "",
    `WORKFLOW INPUT (read-only context):\n${JSON.stringify(ctx)}`,
  ];
  if (transcript.length > 0) {
    parts.push("", "HISTORY SO FAR:", transcript.join("\n"));
  }
  parts.push("", "Respond with your next JSON action, or the final answer if the goal is complete.");
  return parts.join("\n");
}

function renderStep(step: AgentStep): string {
  const head = `STEP ${step.step}: tool=${step.tool ?? "(none)"}${step.simulated ? " (SIMULATED)" : ""}`;
  const body = step.error
    ? `ERROR: ${step.error}`
    : `OBSERVATION: ${JSON.stringify(cap(step.observation, TRANSCRIPT_OBS_CAP))}`;
  return `${head}\n${body}`;
}

// ── The loop ────────────────────────────────────────────────────────────────

/**
 * Run the autonomous agent loop. Never throws — always resolves to an
 * AgentResult whose `status` maps 1:1 onto the ai.agent node's catalog
 * branches (success | max_steps | error).
 */
export async function runAgent(opts: AgentRunOptions): Promise<AgentResult> {
  const startedAt = Date.now();
  const steps: AgentStep[] = [];
  const transcript: string[] = [];
  const toolByType = new Map(opts.tools.map((t) => [t.type, t]));
  let parseFailures = 0;

  // Lazy imports keep this module @workspace/db-free at load time.
  const { auditLog } = await import("../audit");
  const { callLLM } = await import("../ai-provider");

  const finish = async (
    status: AgentResult["status"],
    summary: string,
    extra: Partial<AgentResult> = {},
  ): Promise<AgentResult> => {
    const result: AgentResult = {
      status,
      summary,
      steps,
      stepsRun: steps.length,
      stopReason: extra.stopReason ?? status,
      dryRun: opts.dryRun,
      result: extra.result,
      error: extra.error,
    };
    await auditLog("automation_agent", String(opts.runId), "agent_run_complete", {
      firm_id: opts.firmId,
      workflow_id: opts.workflowId,
      status,
      steps_run: result.stepsRun,
      stop_reason: result.stopReason,
      dry_run: opts.dryRun,
    }).catch(() => {});
    logger.info(
      { runId: opts.runId, workflowId: opts.workflowId, status, stepsRun: result.stepsRun },
      "ai.agent: run complete",
    );
    return result;
  };

  const systemPrompt = buildSystemPrompt(opts);

  for (let step = 1; step <= opts.maxSteps; step++) {
    if (Date.now() - startedAt > opts.timeBudgetMs) {
      return finish("max_steps", `Stopped: time budget of ${opts.timeBudgetMs}ms exceeded.`, {
        stopReason: "time_budget",
      });
    }

    // ── PLAN — ask the planner for the next move.
    let raw: string;
    try {
      raw = await callLLM({
        module: "lead-intelligence",
        systemPrompt,
        prompt: buildTurnPrompt(opts, transcript),
        maxTokens: PLANNER_MAX_TOKENS,
        model: opts.model,
      });
    } catch (err) {
      return finish("error", "The planner LLM call failed.", {
        stopReason: "llm_error",
        error: (err as Error)?.message ?? String(err),
      });
    }

    const parsed = parseAgentAction(raw);
    if (!parsed.ok) {
      parseFailures++;
      transcript.push(
        `STEP ${step}: your reply could not be parsed (${parsed.error}). ` +
          "Reply with ONLY the JSON object in the required format.",
      );
      if (parseFailures >= MAX_PARSE_FAILURES) {
        return finish(
          "error",
          `Stopped: the planner produced unparseable output ${MAX_PARSE_FAILURES}× in a row.`,
          { stopReason: "parse_failures", error: parsed.error },
        );
      }
      continue;
    }
    parseFailures = 0;

    // ── FINAL — the agent declares the goal resolved.
    if (parsed.kind === "final") {
      return finish("success", parsed.summary, { stopReason: "final_answer", result: parsed.result });
    }

    // ── ACT — resolve and invoke the chosen tool.
    const agentStep: AgentStep = { step, thought: parsed.thought, tool: parsed.tool, params: parsed.params };
    const tool = toolByType.get(parsed.tool);

    if (!tool) {
      agentStep.error =
        `Tool "${parsed.tool}" is not available to this agent. ` +
        `Allowed tools: ${[...toolByType.keys()].join(", ")}`;
      steps.push(agentStep);
      transcript.push(renderStep(agentStep));
      continue;
    }

    // Stuck-loop guard — abort if this exact call already ran twice in a row.
    const key = paramsKey(parsed.tool, parsed.params);
    if (countTrailingRepeats(steps, key) >= STUCK_REPEAT_THRESHOLD - 1) {
      agentStep.error = "Aborted: identical tool call repeated — agent is stuck in a loop.";
      steps.push(agentStep);
      return finish("error", "Stopped: the agent repeated the same tool call and made no progress.", {
        stopReason: "stuck_loop",
        error: agentStep.error,
      });
    }

    agentStep.access = tool.access;

    if (opts.dryRun && tool.access === "write") {
      agentStep.simulated = true;
      agentStep.observation = {
        simulated: true,
        note: "dry-run: write tool was not executed",
        would_call: { tool: parsed.tool, params: parsed.params },
      };
    } else {
      try {
        const out = await tool.invoke(parsed.params);
        agentStep.observation = cap(out, OBSERVATION_CHAR_CAP);
      } catch (err) {
        agentStep.error = (err as Error)?.message ?? String(err);
      }
    }

    steps.push(agentStep);
    transcript.push(renderStep(agentStep));

    await auditLog(
      "automation_agent",
      String(opts.runId),
      agentStep.simulated
        ? "agent_tool_simulated"
        : agentStep.error
          ? "agent_tool_error"
          : "agent_tool_call",
      {
        firm_id: opts.firmId,
        workflow_id: opts.workflowId,
        step,
        tool: parsed.tool,
        access: tool.access,
        error: agentStep.error ?? null,
      },
    ).catch(() => {});
  }

  return finish(
    "max_steps",
    `Reached the step cap of ${opts.maxSteps} without a final answer.`,
    { stopReason: "max_steps" },
  );
}
