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
import { Permission, requirePermission } from "../lib/rbac";
import { callLLM } from "../lib/ai-provider";
import { getAiConstitutionPreamble } from "../lib/ai-constitution";
import { loadVapiApiKey, VapiMCPClient } from "../lib/voice/vapi-mcp";
import {
  db,
  leadsTable,
  casesTable,
  documentsTable,
  auditLogTable,
  jobQueueTable,
  reviewQueueTable,
  formConfigurationsTable,
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

## Behavior Rules
- You are fully wired to this CRM. Speak about CRM data with confidence using the snapshot above.
- Answer questions about leads, cases, forms, compliance, workflows, and operations directly.
- For actions that mutate data (bulk updates, deletions, sends), explain what the operator should do in the UI — do not claim to perform mutations yourself. EXCEPTION: Vapi actions use the <vapi_action> tag.
- Be concise and precise. This is an operator tool, not a customer chat.
- If asked about a specific lead, case, or document by ID, tell the operator you cannot look up individual records in this chat but direct them to the relevant CRM page.
- Format responses with markdown when structure helps. Use bullet lists and bold for key data.
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

  // Check if the LLM wants to call a Vapi tool
  const vapiAction = extractVapiAction(rawReply);
  const visibleReply = rawReply.replace(/<vapi_action>[\s\S]*?<\/vapi_action>/g, "").trim();

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
