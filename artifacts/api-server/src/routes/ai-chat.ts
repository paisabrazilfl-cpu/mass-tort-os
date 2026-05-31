/**
 * MTOS Internal Agent — conversational chat endpoint.
 *
 * POST /api/ai-chat
 *   Body:  { message: string; history?: { role: "user"|"assistant"; content: string }[] }
 *   Returns: { reply: string; crmContext?: object; vapiAction?: object }
 *
 * The agent is fully wired to the CRM:
 *   - AI Constitution governs every response
 *   - Live CRM snapshot (counts, nav, recent activity) injected as context
 *   - Conversation history threaded as a formatted log
 *   - Uses lead-intelligence LLM module (Anthropic fallback)
 *   - When Vapi is configured, Vapi MCP tools are auto-injected so the
 *     agent can manage assistants, phone numbers, and calls via chat
 */

import { Router } from "express";
import { Permission, requirePermission, hasPermission, type AuthUser } from "../lib/rbac";
import { callLLM } from "../lib/ai-provider";
import { getAiConstitutionPreamble } from "../lib/ai-constitution";
import { loadVapiApiKey, VapiMCPClient } from "../lib/voice/vapi-mcp";
import { runCrmLookup, CRM_ENTITIES, type CrmEntity } from "../lib/agent-crm-tools";
import { planAutomationGraph } from "../lib/automations/assist-planner";
import {
  db,
  leadsTable,
  casesTable,
  documentsTable,
  auditLogTable,
  jobQueueTable,
  reviewQueueTable,
  formConfigurationsTable,
  automationWorkflowsTable,
} from "@workspace/db";
import { sql, desc, eq } from "drizzle-orm";
import { z } from "zod";

const router = Router();

// ── schema ────────────────────────────────────────────────────────────────────

const MessageSchema = z.object({
  role: z.enum(["user", "assistant"]),
  content: z.string().max(8000),
});

const ChatRequestSchema = z.object({
  message: z.string().min(1).max(4000),
  history: z.array(MessageSchema).max(30).default([]),
});

// ── helpers ───────────────────────────────────────────────────────────────────

async function getCrmSnapshot(firmId: number | null) {
  const [leadCounts, casesTotal, docsTotal, pendingJobs, reviewDepth, activeForms, recentActivity] =
    await Promise.all([
      db
        .select({ status: leadsTable.status, count: sql<number>`count(*)::int` })
        .from(leadsTable)
        .where(firmId ? eq(leadsTable.firm_id, firmId) : sql`true`)
        .groupBy(leadsTable.status)
        .catch(() => null),
      db.select({ count: sql<number>`count(*)::int` }).from(casesTable).catch(() => null),
      db.select({ count: sql<number>`count(*)::int` }).from(documentsTable).catch(() => null),
      db
        .select({ count: sql<number>`count(*)::int` })
        .from(jobQueueTable)
        .where(eq(jobQueueTable.status, "pending"))
        .catch(() => null),
      db
        .select({ count: sql<number>`count(*)::int` })
        .from(reviewQueueTable)
        .where(eq(reviewQueueTable.resolution, "pending"))
        .catch(() => null),
      db
        .select({ count: sql<number>`count(*)::int` })
        .from(formConfigurationsTable)
        .where(eq(formConfigurationsTable.active, true))
        .catch(() => null),
      db
        .select({ action: auditLogTable.action, entity_type: auditLogTable.entity_type, occurred_at: auditLogTable.occurred_at })
        .from(auditLogTable)
        .orderBy(desc(auditLogTable.occurred_at))
        .limit(5)
        .catch(() => null),
    ]);

  const leadsByStatus = leadCounts
    ? Object.fromEntries(leadCounts.map((r) => [r.status, r.count]))
    : {};

  return {
    leads: {
      by_status: leadsByStatus,
      total: leadCounts ? leadCounts.reduce((s, r) => s + r.count, 0) : 0,
    },
    cases: casesTotal?.[0]?.count ?? 0,
    documents: docsTotal?.[0]?.count ?? 0,
    pending_jobs: pendingJobs?.[0]?.count ?? 0,
    review_queue: reviewDepth?.[0]?.count ?? 0,
    active_forms: activeForms?.[0]?.count ?? 0,
    recent_activity: recentActivity ?? [],
  };
}

// Load Vapi MCP tool catalog (non-fatal — Vapi section is optional)
async function getVapiToolContext(): Promise<{ configured: boolean; toolsText: string }> {
  try {
    const apiKey = await loadVapiApiKey();
    if (!apiKey) return { configured: false, toolsText: "" };
    const client = new VapiMCPClient();
    const tools = await client.listTools(apiKey);
    const toolsText = tools.map((t) => `  • ${t.name}: ${t.description ?? ""}`).join("\n");
    return { configured: true, toolsText };
  } catch {
    return { configured: false, toolsText: "" };
  }
}

// Parse a <vapi_action> tag from the LLM reply
function extractVapiAction(reply: string): { tool: string; args: Record<string, unknown> } | null {
  const match = reply.match(/<vapi_action>([\s\S]*?)<\/vapi_action>/);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[1].trim());
    if (typeof parsed?.tool === "string") return parsed;
  } catch { /* ignore */ }
  return null;
}

// Parse a <crm_lookup> tag — Abby's row-level CRM read tool.
function extractCrmLookup(reply: string): {
  entity: CrmEntity;
  id?: string | number;
  search?: string;
  status?: string;
  limit?: number;
} | null {
  const match = reply.match(/<crm_lookup>([\s\S]*?)<\/crm_lookup>/);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[1].trim());
    if (parsed && typeof parsed.entity === "string" && (CRM_ENTITIES as readonly string[]).includes(parsed.entity)) {
      return parsed;
    }
  } catch { /* ignore */ }
  return null;
}

// Parse an <automation_plan> tag — Abby's workflow-planning tool. Mirrors
// the Automation Center's /assist planner, then saves a DISABLED draft.
function extractAutomationPlan(reply: string): { prompt: string; name?: string } | null {
  const match = reply.match(/<automation_plan>([\s\S]*?)<\/automation_plan>/);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[1].trim());
    if (parsed && typeof parsed.prompt === "string" && parsed.prompt.trim().length >= 3) {
      return { prompt: parsed.prompt, name: typeof parsed.name === "string" ? parsed.name : undefined };
    }
  } catch { /* ignore */ }
  return null;
}

// Per-entity authorization gate for Abby's <crm_lookup> tool. Abby itself
// is reachable with only DASHBOARD_VIEW, so EACH record read must be
// re-checked against the caller's actual permissions — otherwise a viewer
// could read leads/cases through the agent that they cannot see in the UI.
// Returns whether the read is allowed, whether it must be restricted to the
// caller's OWN (assigned) records, and an operator-facing note when denied.
function crmLookupGate(
  user: AuthUser | undefined,
  entity: CrmEntity,
): { allowed: boolean; ownScope: boolean; note?: string } {
  const deny = (note: string) => ({ allowed: false, ownScope: false, note });
  switch (entity) {
    case "leads":
      if (hasPermission(user, Permission.LEAD_VIEW_ANY)) return { allowed: true, ownScope: false };
      if (hasPermission(user, Permission.LEAD_VIEW_OWN)) return { allowed: true, ownScope: true };
      return deny("You don't have permission to view leads.");
    case "documents":
      if (hasPermission(user, Permission.DOCUMENTS_VIEW)) {
        // If the caller can only see their OWN leads, scope documents the
        // same way (to records on leads assigned to them).
        const own =
          !hasPermission(user, Permission.LEAD_VIEW_ANY) &&
          hasPermission(user, Permission.LEAD_VIEW_OWN);
        return { allowed: true, ownScope: own };
      }
      return deny("You don't have permission to view documents.");
    case "forms":
      if (hasPermission(user, Permission.FORMS_CONFIG_VIEW)) return { allowed: true, ownScope: false };
      return deny("You don't have permission to view full tort campaign configuration.");
    case "cases":
    case "review":
    case "jobs":
      // These tables carry no firm_id, so row-level reads cannot be safely
      // firm-scoped — limit to the platform owner (super_admin).
      if (user?.role === "super_admin") return { allowed: true, ownScope: false };
      return deny(`Row-level "${entity}" lookups are limited to the platform owner because this data is not firm-scoped.`);
    default:
      return deny("Unknown lookup entity.");
  }
}

// Strip every action tag from the model's reply before showing it.
function stripActionTags(reply: string): string {
  return reply
    .replace(/<vapi_action>[\s\S]*?<\/vapi_action>/g, "")
    .replace(/<crm_lookup>[\s\S]*?<\/crm_lookup>/g, "")
    .replace(/<automation_plan>[\s\S]*?<\/automation_plan>/g, "")
    .trim();
}

// ── POST /api/ai-chat ─────────────────────────────────────────────────────────

router.post("/", requirePermission(Permission.DASHBOARD_VIEW), async (req, res) => {
  const parsed = ChatRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid request", details: parsed.error.flatten() });
    return;
  }

  const { message, history } = parsed.data;
  const firmId: number | null = (req as any).user?.firm_id ?? null;
  const userRole: string = (req as any).user?.role ?? "viewer";

  // Fetch CRM snapshot and Vapi MCP tool list in parallel
  const [snapshot, vapiCtx] = await Promise.all([
    getCrmSnapshot(firmId),
    getVapiToolContext(),
  ]);

  const constitution = getAiConstitutionPreamble();

  // Build Vapi section for system prompt (only when configured)
  const vapiSection = vapiCtx.configured
    ? `
## Vapi AI Integration (ACTIVE)
You are connected to the Vapi MCP server. You can manage Vapi assistants, phone numbers, and calls directly from this chat.

Available Vapi tools:
${vapiCtx.toolsText}

When the operator asks you to perform a Vapi action (create/list/update/delete an assistant, list calls, manage phone numbers, etc.), include a machine-readable action tag at the END of your reply:

<vapi_action>{"tool": "exactToolName", "args": {...}}</vapi_action>

Rules for the action tag:
- Use the EXACT tool name from the list above
- Populate args from what the operator said; use {} for list operations with no filters
- Only include ONE action tag per reply
- Place it at the very end of your message (it will be stripped and executed invisibly)
- For everything else (questions, analysis, CRM data), reply normally without the tag
`
    : `
## Vapi AI Integration (NOT CONFIGURED)
Vapi is not yet configured. If the operator asks about Vapi or AI calling, tell them to go to **Integrations → Voice AI → Vapi** and add their API key. Once saved, you will have full Vapi management capability here.
`;

  const systemPrompt = `${constitution}

## Live CRM State (as of ${new Date().toISOString()})
You are the MTOS Internal Agent — the operator's private AI assistant embedded directly in the Mass Tort Operating System CRM. You have real-time read access to the CRM and can answer questions about any data, workflow, lead, case, compliance issue, or operational matter.

**Current CRM Snapshot:**
- Leads: ${snapshot.leads.total} total | By status: ${JSON.stringify(snapshot.leads.by_status)}
- Cases open: ${snapshot.cases}
- Documents stored: ${snapshot.documents}
- Jobs pending in queue: ${snapshot.pending_jobs}
- Review queue depth: ${snapshot.review_queue}
- Active intake forms: ${snapshot.active_forms}

**Recent Activity (last 5 events):**
${snapshot.recent_activity.map((e) => `- ${e.action} on ${e.entity_type} at ${e.occurred_at}`).join("\n") || "  (none)"}

**Operator context:**
- Role: ${userRole}
- Firm ID: ${firmId ?? "super_admin (all firms)"}

## CRM Record Lookup (ACTIVE)
You can read ACTUAL ROWS from the CRM — not just the counts above. When the operator asks about a specific lead, case, document, form/tort campaign, review-queue item, or job (by id, by name/email/phone, by status, or "list the latest"), fetch the real data by ending your reply with ONE lookup tag:

<crm_lookup>{"entity": "leads", "search": "jane@example.com", "limit": 5}</crm_lookup>

- entity (required) is one of: ${CRM_ENTITIES.join(", ")}.
- Optional: "id" (exact record id), "search" (name/email/phone/keyword), "status", "limit" (1-50, default 10).
- All results are automatically firm-scoped to the operator; you never need to add a firm filter.
- "cases", "review", and "jobs" are only available to the platform owner (super_admin); for other operators the tool returns a note explaining the restriction — relay it honestly.
- Place the tag at the very END of your reply (it is stripped and executed; the data is then handed back to you to summarize).

## Automation Builder (ACTIVE)
You have the SAME workflow-planning capacity as the Automation Center assistant. When the operator asks you to build/create/automate a workflow ("when a lead qualifies, send the e-sign packet and notify the paralegal"), end your reply with ONE plan tag:

<automation_plan>{"prompt": "full plain-English description of the workflow the operator wants", "name": "Short Workflow Name"}</automation_plan>

- "prompt" (required): pass the operator's full intent — be specific about triggers, conditions, and actions.
- "name" (optional): a short title for the saved draft.
- The plan is generated, validated against the node catalog, and saved as a DISABLED draft in the Automation Center. You then tell the operator it's saved as a draft and link them to **/automations** to review, tweak, and enable it. You NEVER enable workflows yourself (Constitution bright line).

## Behavior Rules
- You are fully wired to this CRM. Speak about CRM data with confidence using the snapshot above, and use <crm_lookup> for anything record-specific.
- Answer questions about leads, cases, forms, compliance, workflows, and operations directly.
- For actions that mutate data (bulk updates, deletions, sends), explain what the operator should do in the UI — do not claim to perform mutations yourself. EXCEPTIONS: Vapi actions (<vapi_action>), record lookups (<crm_lookup>), and saving automation drafts (<automation_plan>).
- Use at most ONE action tag per reply.
- Be concise and precise. This is an operator tool, not a customer chat.
- Format responses with markdown when structure helps. Use bullet lists and bold for key data. Use markdown links like [Automation Center](/automations) when pointing to a CRM page.
${vapiSection}`;

  const turns = [
    ...history.map((m) => `${m.role === "user" ? "Operator" : "MTOS Agent"}: ${m.content}`),
    `Operator: ${message}`,
    `MTOS Agent:`,
  ].join("\n\n");

  let rawReply: string;
  try {
    rawReply = await callLLM({
      module: "lead-intelligence",
      systemPrompt,
      prompt: turns,
      maxTokens: 1024,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    req.log.warn({ err: msg }, "ai-chat: LLM call failed");
    res.json({
      reply:
        "I'm not able to respond right now — no AI provider is configured yet. " +
        "Once your API key is wired in, I'll have full access to your CRM data and can answer any question.",
      crmContext: snapshot,
    });
    return;
  }

  // Strip every action tag so the operator never sees the raw machine call.
  const visibleReply = stripActionTags(rawReply);

  // ── CRM record lookup ──────────────────────────────────────────────────────
  const crmLookup = extractCrmLookup(rawReply);
  if (crmLookup) {
    // Re-authorize the read against the caller's actual permissions — Abby is
    // reachable with only DASHBOARD_VIEW, so each entity must be re-checked.
    const gate = crmLookupGate(req.user, crmLookup.entity);
    if (!gate.allowed) {
      const note = gate.note ?? "You don't have permission to view that data.";
      res.json({
        reply: visibleReply ? `${visibleReply}\n\n${note}` : note,
        crmContext: snapshot,
        crmLookup: { entity: crmLookup.entity, ok: false, denied: true },
      });
      return;
    }
    const lookup = await runCrmLookup({
      ...crmLookup,
      firmId,
      isSuperAdmin: userRole === "super_admin",
      userId: req.user?.id ?? null,
      ownScope: gate.ownScope,
    });

    // Hand the rows back to the model to summarize in operator-facing prose.
    let lookupSummary = "";
    try {
      lookupSummary = await callLLM({
        module: "lead-intelligence",
        systemPrompt:
          "You are the MTOS Internal Agent. Summarize CRM lookup results for the operator in clean, concise markdown. " +
          "Report exactly what the data shows — never invent fields or rows. If the result is empty, say so plainly. " +
          "If a restriction note is present, relay it honestly.",
        prompt:
          `The operator asked: "${message}"\n\n` +
          `CRM lookup (entity=${lookup.entity}, scope=${lookup.scope}, count=${lookup.count}) returned:\n` +
          `${JSON.stringify({ note: lookup.note, rows: lookup.rows }).slice(0, 12_000)}\n\n` +
          "Write a concise operator-facing summary.",
        maxTokens: 700,
      });
    } catch {
      lookupSummary =
        lookup.count > 0
          ? `Found ${lookup.count} ${lookup.entity} record(s) (${lookup.scope}).`
          : lookup.note ?? `No matching ${lookup.entity} records found.`;
    }

    res.json({
      reply: visibleReply ? `${visibleReply}\n\n${lookupSummary}` : lookupSummary,
      crmContext: snapshot,
      crmLookup: { entity: lookup.entity, scope: lookup.scope, count: lookup.count, ok: lookup.ok },
    });
    return;
  }

  // ── Automation draft builder ───────────────────────────────────────────────
  const automationPlan = extractAutomationPlan(rawReply);
  if (automationPlan) {
    // Drafting a workflow writes to automation_workflows — require the same
    // permission the Automation Center enforces. Refuse politely in-chat
    // (don't 403 the whole conversation) when the caller lacks it.
    if (!hasPermission(req.user, Permission.AUTOMATIONS_MANAGE)) {
      const note =
        "You don't have permission to create automations. Ask a firm admin to set this up in the Automation Center.";
      res.json({
        reply: visibleReply ? `${visibleReply}\n\n${note}` : note,
        crmContext: snapshot,
        automationPlan: { ok: false, code: "forbidden" },
      });
      return;
    }
    const plan = await planAutomationGraph({ prompt: automationPlan.prompt, mode: "replace" });

    if (!plan.ok) {
      const failMsg =
        plan.code === "llm_unavailable"
          ? "I couldn't reach the planner to build that workflow right now. Please try again in a moment."
          : `I tried to build that workflow but couldn't produce a valid graph after ${plan.attempts.length} attempt(s): ${plan.message} You can also build it directly in the [Automation Center](/automations).`;
      res.json({
        reply: visibleReply ? `${visibleReply}\n\n${failMsg}` : failMsg,
        crmContext: snapshot,
        automationPlan: { ok: false, code: plan.code },
      });
      return;
    }

    // Persist as a DISABLED draft (never auto-enable — Constitution bright line).
    let saved: { id: number } | null = null;
    try {
      const draftName =
        automationPlan.name?.trim() ||
        `Abby draft — ${automationPlan.prompt.slice(0, 60)}${automationPlan.prompt.length > 60 ? "…" : ""}`;
      const [row] = await db
        .insert(automationWorkflowsTable)
        .values({
          firm_id: firmId,
          name: draftName,
          description: plan.explanation || "Drafted by Abby (internal agent).",
          graph: plan.graph,
          enabled: false,
          created_by_user_id: (req as any).user?.id ?? null,
          tags: ["abby-draft"],
        })
        .returning({ id: automationWorkflowsTable.id });
      saved = row ?? null;
    } catch (err) {
      req.log.warn({ err: err instanceof Error ? err.message : String(err) }, "ai-chat: failed to save automation draft");
    }

    const summary = saved
      ? `Done — I drafted that workflow and saved it as a **disabled draft** in the Automation Center. ` +
        `${plan.explanation ? `\n\n${plan.explanation}` : ""}` +
        `\n\nReview, tweak, and enable it here: [Automation Center](/automations/${saved.id}). It will not run until you turn it on.`
      : `I built the workflow graph but couldn't save the draft just now. You can recreate it in the [Automation Center](/automations).`;

    res.json({
      reply: visibleReply ? `${visibleReply}\n\n${summary}` : summary,
      crmContext: snapshot,
      automationPlan: saved
        ? { ok: true, workflowId: saved.id, warnings: plan.warnings }
        : { ok: false, code: "save_failed", workflowId: null },
    });
    return;
  }

  // ── Vapi tool call (existing) ──────────────────────────────────────────────
  const vapiAction = extractVapiAction(rawReply);

  if (vapiAction && vapiCtx.configured) {
    const apiKey = await loadVapiApiKey();
    if (apiKey) {
      const client = new VapiMCPClient();
      const toolResult = await client.callTool(apiKey, vapiAction.tool, vapiAction.args);

      // Re-prompt the LLM to summarise the result in natural language
      let actionSummary = toolResult.rawText ?? "(no output)";
      try {
        actionSummary = await callLLM({
          module: "lead-intelligence",
          systemPrompt: "You are the MTOS Vapi AI Manager. Format Vapi API results into clean, concise operator-facing summaries. Use markdown.",
          prompt: `The operator asked: "${message}"\n\nVapi tool "${vapiAction.tool}" returned:\n${toolResult.rawText ?? JSON.stringify(toolResult.content)}\n\nWrite a concise operator summary.`,
          maxTokens: 512,
        });
      } catch { /* use rawText */ }

      res.json({
        reply: visibleReply ? `${visibleReply}\n\n${actionSummary}` : actionSummary,
        crmContext: snapshot,
        vapiAction: {
          tool: vapiAction.tool,
          args: vapiAction.args,
          result: toolResult,
        },
      });
      return;
    }
  }

  res.json({ reply: visibleReply || rawReply, crmContext: snapshot });
});

export default router;
