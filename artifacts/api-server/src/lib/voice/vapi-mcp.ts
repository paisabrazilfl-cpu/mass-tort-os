/**
 * Vapi MCP Client — connects to the Vapi MCP server at https://mcp.vapi.ai/mcp
 * and exposes typed wrappers for every Vapi management action.
 *
 * The client uses the MCP Streamable HTTP transport (JSON-RPC 2.0 over POST).
 * Auth: Authorization: Bearer <api_key> — reads from the integration vault
 * automatically, so adding the Vapi API key to Integrations → Vapi is all
 * that is needed to activate MCP support.
 *
 * Session lifecycle:
 *   initialize → list tools (cached) → call tool
 * A single instance is created per request context; session IDs are per-call.
 */

import { db, integrationsTable } from "@workspace/db";
import { and, eq } from "drizzle-orm";
import { getIntegrationCredentialsById } from "../../routes/integrations";
import { logger } from "../logger";

const VAPI_MCP_URL = "https://mcp.vapi.ai/mcp";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface MCPTool {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

export interface MCPCallResult {
  ok: boolean;
  content?: Array<{ type: string; text?: string }>;
  isError?: boolean;
  error?: string;
  rawText?: string;
}

interface RpcEnvelope {
  jsonrpc: "2.0";
  id: number;
  result?: unknown;
  error?: { code: number; message: string };
}

// ── Load API key from vault ───────────────────────────────────────────────────

export async function loadVapiApiKey(): Promise<string | null> {
  try {
    const rows = await db
      .select({ id: integrationsTable.id })
      .from(integrationsTable)
      .where(and(eq(integrationsTable.provider, "vapi"), eq(integrationsTable.status, "active")))
      .limit(1);
    if (!rows[0]) return null;
    const creds = await getIntegrationCredentialsById(rows[0].id);
    const key = typeof creds?.api_key === "string" ? creds.api_key.trim() : "";
    return key || null;
  } catch (err) {
    logger.error({ err }, "vapi-mcp: failed to load API key from vault");
    return null;
  }
}

// ── Low-level MCP HTTP request ────────────────────────────────────────────────

async function mcpPost(
  apiKey: string,
  sessionId: string | null,
  payload: Record<string, unknown>,
): Promise<{ rpc: RpcEnvelope | null; newSessionId: string | null }> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
  };
  if (sessionId) headers["Mcp-Session-Id"] = sessionId;

  let res: Response;
  try {
    res = await fetch(VAPI_MCP_URL, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (err) {
    logger.error({ err }, "vapi-mcp: network error");
    return { rpc: null, newSessionId: null };
  }

  const newSessionId = res.headers.get("mcp-session-id");
  const ct = res.headers.get("content-type") ?? "";
  const targetId = typeof payload.id === "number" ? payload.id : null;

  let rpc: RpcEnvelope | null = null;

  if (ct.includes("text/event-stream")) {
    const text = await res.text().catch(() => "");
    const dataLines = text
      .split("\n")
      .filter((l) => l.startsWith("data:"))
      .map((l) => l.slice(5).trim())
      .filter((l) => l.length > 0 && l !== "[DONE]");

    for (const line of dataLines) {
      try {
        const parsed = JSON.parse(line) as RpcEnvelope;
        if (targetId == null || parsed.id === targetId) {
          if (parsed.result !== undefined || parsed.error !== undefined) {
            rpc = parsed;
            break;
          }
        }
      } catch {
        /* skip non-JSON lines */
      }
    }
  } else {
    try {
      rpc = (await res.json()) as RpcEnvelope;
    } catch {
      rpc = null;
    }
  }

  return { rpc, newSessionId };
}

// ── VapiMCPClient ─────────────────────────────────────────────────────────────

export class VapiMCPClient {
  private sessionId: string | null = null;
  private _tools: MCPTool[] | null = null;
  private msgId = 0;

  private id() {
    return ++this.msgId;
  }

  async initialize(apiKey: string): Promise<boolean> {
    const { rpc, newSessionId } = await mcpPost(apiKey, null, {
      jsonrpc: "2.0",
      id: this.id(),
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        clientInfo: { name: "mtos-crm", version: "1.0.0" },
      },
    });
    if (newSessionId) this.sessionId = newSessionId;
    return rpc?.result != null;
  }

  async listTools(apiKey: string): Promise<MCPTool[]> {
    if (this._tools) return this._tools;
    await this.initialize(apiKey);
    const { rpc } = await mcpPost(apiKey, this.sessionId, {
      jsonrpc: "2.0",
      id: this.id(),
      method: "tools/list",
    });
    const tools = ((rpc?.result as any)?.tools ?? []) as MCPTool[];
    this._tools = tools;
    return tools;
  }

  async callTool(
    apiKey: string,
    name: string,
    args: Record<string, unknown>,
  ): Promise<MCPCallResult> {
    if (!this.sessionId) await this.initialize(apiKey);

    const { rpc } = await mcpPost(apiKey, this.sessionId, {
      jsonrpc: "2.0",
      id: this.id(),
      method: "tools/call",
      params: { name, arguments: args },
    });

    if (!rpc) return { ok: false, error: "No response from Vapi MCP server" };
    if (rpc.error) return { ok: false, error: rpc.error.message };

    const toolResult = rpc.result as any;
    const content: Array<{ type: string; text?: string }> = Array.isArray(toolResult?.content)
      ? toolResult.content
      : [];

    const rawText = content
      .filter((c) => c.type === "text")
      .map((c) => c.text ?? "")
      .join("\n");

    return {
      ok: true,
      content,
      isError: toolResult?.isError ?? false,
      rawText,
    };
  }
}

// ── Module-level helpers (new client per call, stateless from caller POV) ─────

export async function vapiMcpListTools(): Promise<{ ok: boolean; tools: MCPTool[]; error?: string }> {
  const apiKey = await loadVapiApiKey();
  if (!apiKey) return { ok: false, tools: [], error: "Vapi API key not configured in Integrations vault" };
  try {
    const client = new VapiMCPClient();
    const tools = await client.listTools(apiKey);
    return { ok: true, tools };
  } catch (err) {
    return { ok: false, tools: [], error: String((err as Error).message) };
  }
}

export async function vapiMcpCallTool(
  name: string,
  args: Record<string, unknown>,
): Promise<MCPCallResult> {
  const apiKey = await loadVapiApiKey();
  if (!apiKey) return { ok: false, error: "Vapi API key not configured in Integrations vault" };
  try {
    const client = new VapiMCPClient();
    return await client.callTool(apiKey, name, args);
  } catch (err) {
    return { ok: false, error: String((err as Error).message) };
  }
}
