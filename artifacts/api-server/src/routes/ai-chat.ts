/**
 * MTOS Internal Agent — conversational chat endpoint.
 *
 * POST /api/ai-chat
 *   Body:  { message: string; history?: { role: "user"|"assistant"; content: string }[] }
 *   Returns: { reply: string; crmContext?: object }
 *
 * The agent is fully wired to the CRM:
 *   - AI Constitution governs every response
 *   - Live CRM snapshot (counts, nav, recent activity) injected as context
 *   - Conversation history threaded as a formatted log
 *   - Uses lead-intelligence LLM module (Anthropic fallback)
 */

import { Router } from "express";
import { Permission, requirePermission } from "../lib/rbac";
import { callLLM } from "../lib/ai-provider";
import { getAiConstitutionPreamble } from "../lib/ai-constitution";
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

  // Live CRM context
  const snapshot = await getCrmSnapshot(firmId);

  // AI Constitution preamble
  const constitution = getAiConstitutionPreamble();

  // Build system prompt
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
- For actions that mutate data (bulk updates, deletions, sends), explain what the operator should do in the UI — do not claim to perform mutations yourself.
- Be concise and precise. This is an operator tool, not a customer chat.
- If asked about a specific lead, case, or document by ID, tell the operator you cannot look up individual records in this chat but direct them to the relevant CRM page.
- Format responses with markdown when structure helps. Use bullet lists and bold for key data.`;

  // Thread history into a prompt (Anthropic-compatible turn format)
  const turns = [
    ...history.map((m) => `${m.role === "user" ? "Operator" : "MTOS Agent"}: ${m.content}`),
    `Operator: ${message}`,
    `MTOS Agent:`,
  ].join("\n\n");

  const reply = await callLLM({
    module: "lead-intelligence",
    systemPrompt,
    prompt: turns,
    maxTokens: 1024,
  });

  res.json({ reply, crmContext: snapshot });
});

export default router;
