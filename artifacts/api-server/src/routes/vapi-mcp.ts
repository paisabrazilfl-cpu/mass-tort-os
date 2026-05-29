/**
 * Vapi MCP routes — exposes the Vapi MCP server to the CRM frontend.
 *
 * GET  /api/vapi-mcp/tools          list all available MCP tools (names + descriptions)
 * POST /api/vapi-mcp/call           call a specific tool { tool, args }
 * POST /api/vapi-mcp/chat           natural-language → tool call → result
 *
 * All routes require DASHBOARD_VIEW. The API key is read automatically from
 * the Vapi integration vault — no extra config needed beyond adding the key
 * to Integrations → Voice AI → Vapi.
 */

import { Router } from "express";
import { z } from "zod";
import { Permission, requirePermission } from "../lib/rbac";
import { vapiMcpListTools, vapiMcpCallTool, loadVapiApiKey, VapiMCPClient } from "../lib/voice/vapi-mcp";
import { callLLM } from "../lib/ai-provider";

const router = Router();
router.use(requirePermission(Permission.DASHBOARD_VIEW));

// ── GET /api/vapi-mcp/tools ───────────────────────────────────────────────────

router.get("/tools", async (req, res) => {
  const result = await vapiMcpListTools();
  if (!result.ok) {
    res.status(424).json({ error: result.error });
    return;
  }
  res.json({ tools: result.tools });
});

// ── POST /api/vapi-mcp/call ───────────────────────────────────────────────────

const CallSchema = z.object({
  tool: z.string().min(1).max(120),
  args: z.record(z.unknown()).default({}),
});

router.post("/call", async (req, res) => {
  const parsed = CallSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid request", details: parsed.error.flatten() });
    return;
  }
  const result = await vapiMcpCallTool(parsed.data.tool, parsed.data.args);
  res.json(result);
});

// ── POST /api/vapi-mcp/chat ───────────────────────────────────────────────────
// Natural-language → intent parse → MCP tool call → formatted reply

const ChatSchema = z.object({
  message: z.string().min(1).max(2000),
});

router.post("/chat", async (req, res) => {
  const parsed = ChatSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid request", details: parsed.error.flatten() });
    return;
  }

  const apiKey = await loadVapiApiKey();
  if (!apiKey) {
    res.json({
      reply: "Vapi is not configured yet. Go to **Integrations → Voice AI → Vapi** and add your API key. Once saved, all Vapi AI Manager features activate automatically.",
      action: null,
    });
    return;
  }

  // Fetch available tools to inject into system prompt
  const client = new VapiMCPClient();
  let toolsText = "";
  try {
    const tools = await client.listTools(apiKey);
    toolsText = tools
      .map((t) => `  • ${t.name}: ${t.description ?? ""}`)
      .join("\n");
  } catch {
    toolsText = "  (Could not list tools — check API key)";
  }

  // Ask the LLM to map the natural language request to a tool call
  const systemPrompt = `You are the Vapi AI Manager embedded in the MTOS CRM. Your job is to translate the operator's natural-language request into a single Vapi MCP tool call.

Available Vapi MCP tools:
${toolsText}

Rules:
1. Respond with ONLY valid JSON — no prose, no markdown, no explanation.
2. The JSON must have exactly two keys: "tool" (string, the exact tool name) and "args" (object with the tool's arguments).
3. If the request is ambiguous, pick the most likely tool with safe default args (empty object {} if no args needed).
4. If the request does not map to any Vapi tool, set "tool" to "__none__" and "args" to {}.
5. For list operations use {} args unless the operator specifies filters.
6. For create/update operations, populate args from what the operator said; use sensible defaults for required fields.

Examples:
  "list my assistants" → {"tool":"listAssistants","args":{}}
  "show phone numbers" → {"tool":"listPhoneNumbers","args":{}}
  "recent calls" → {"tool":"listCalls","args":{"limit":10}}
  "delete assistant abc123" → {"tool":"deleteAssistant","args":{"id":"abc123"}}`;

  let toolName = "__none__";
  let toolArgs: Record<string, unknown> = {};

  try {
    const raw = await callLLM({
      module: "lead-intelligence",
      systemPrompt,
      prompt: parsed.data.message,
      maxTokens: 256,
    });

    // Strip any accidental markdown fences
    const cleaned = raw.replace(/```json\s*/gi, "").replace(/```/g, "").trim();
    const intent = JSON.parse(cleaned) as { tool?: string; args?: Record<string, unknown> };
    toolName = typeof intent.tool === "string" ? intent.tool : "__none__";
    toolArgs = intent.args && typeof intent.args === "object" ? intent.args : {};
  } catch (err) {
    req.log.warn({ err }, "vapi-mcp chat: intent parse failed");
  }

  if (toolName === "__none__") {
    res.json({
      reply: "I couldn't map your request to a Vapi action. Try something like: *\"list my assistants\"*, *\"show phone numbers\"*, or *\"list recent calls\"*.",
      action: null,
    });
    return;
  }

  // Execute the tool
  const result = await client.callTool(apiKey, toolName, toolArgs);

  if (!result.ok || result.isError) {
    res.json({
      reply: `Vapi returned an error for **${toolName}**: ${result.error ?? result.rawText ?? "unknown error"}`,
      action: { tool: toolName, args: toolArgs },
      result,
    });
    return;
  }

  // Format the result with the LLM for a clean human-readable reply
  let formattedReply = result.rawText ?? "(no output)";
  try {
    const fmtPrompt = `The operator asked: "${parsed.data.message}"\n\nVapi MCP tool "${toolName}" returned this raw JSON result:\n${result.rawText}\n\nWrite a concise, clear reply to the operator summarising what was found or done. Use markdown formatting (bullet lists for collections, bold for key values). Be direct — this is an operator tool.`;
    formattedReply = await callLLM({
      module: "lead-intelligence",
      systemPrompt: "You are the MTOS Vapi AI Manager. Format Vapi API results into clean, concise operator-facing summaries.",
      prompt: fmtPrompt,
      maxTokens: 512,
    });
  } catch {
    /* use rawText as fallback */
  }

  res.json({
    reply: formattedReply,
    action: { tool: toolName, args: toolArgs },
    result,
  });
});

export default router;
