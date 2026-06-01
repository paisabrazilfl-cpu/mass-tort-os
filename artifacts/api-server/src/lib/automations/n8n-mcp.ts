/**
 * n8n MCP bridge — OUTBOUND call direction (CRM → n8n).
 *
 * The CRM already exposes the INBOUND direction (n8n → CRM) via minted
 * `mtos_` API keys (see n8n-setup page) and outbound webhooks. This module
 * is the missing piece: a thin client for the user's live n8n instance's
 * **official MCP server** (Streamable HTTP / JSON-RPC), so automation graphs
 * and operators can RUN n8n workflows as a first-class automation backend.
 *
 * Connection config comes from the environment (never hard-coded):
 *   - N8N_MCP_URL    e.g. https://<tenant>.app.n8n.cloud/mcp-server/http
 *   - N8N_MCP_TOKEN  the n8n MCP server access token (Bearer JWT)
 *
 * The n8n MCP server is stateless (it does not require an mcp-session-id to
 * be threaded across requests), but we still perform the protocol-correct
 * initialize handshake before each tool call and forward a session id if one
 * is returned. Failures THROW (honesty invariant: a non-branch automation
 * node never silently returns a clean result on failure).
 */

const PROTOCOL_VERSION = "2025-06-18";
const CLIENT_INFO = { name: "mtos-crm", version: "1.0.0" } as const;

interface McpConn {
  url: string;
  token: string;
}

function readConn(): McpConn | null {
  const url = process.env["N8N_MCP_URL"]?.trim();
  const token = process.env["N8N_MCP_TOKEN"]?.trim();
  if (!url || !token) return null;
  return { url, token };
}

/** True when both N8N_MCP_URL and N8N_MCP_TOKEN are present. */
export function n8nConfigured(): boolean {
  return readConn() !== null;
}

function requireConn(): McpConn {
  const conn = readConn();
  if (!conn) {
    throw new Error(
      "n8n is not connected. Set N8N_MCP_URL and N8N_MCP_TOKEN in the environment.",
    );
  }
  return conn;
}

function headers(conn: McpConn, sessionId?: string): Record<string, string> {
  const h: Record<string, string> = {
    Authorization: `Bearer ${conn.token}`,
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
  };
  if (sessionId) h["mcp-session-id"] = sessionId;
  return h;
}

interface JsonRpcResponse {
  jsonrpc?: string;
  id?: number | string;
  result?: unknown;
  error?: { code?: number; message?: string; data?: unknown };
}

/** Trim a response body to a short, safe snippet for error messages. */
function snippet(text: string): string {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length > 200 ? `${t.slice(0, 200)}…` : t;
}

/**
 * Parse an MCP HTTP response that may be JSON or an SSE event stream.
 * THROWS when the body cannot be parsed into a JSON-RPC envelope — an
 * unparseable 200 (HTML error page, partial SSE, empty body) must NOT be
 * treated as a clean result (honesty invariant).
 */
async function parseResponse(res: Response, label: string): Promise<JsonRpcResponse> {
  const ct = res.headers.get("content-type") ?? "";
  const text = await res.text();
  let candidate: string | undefined;
  if (ct.includes("text/event-stream")) {
    const dataLines = text
      .split("\n")
      .filter((l) => l.startsWith("data:"))
      .map((l) => l.slice(5).trim())
      .filter(Boolean);
    candidate = dataLines[dataLines.length - 1];
    if (!candidate) {
      throw new Error(`n8n MCP ${label}: SSE stream carried no data frame (got: "${snippet(text)}").`);
    }
  } else {
    candidate = text.trim();
    if (!candidate) {
      throw new Error(`n8n MCP ${label}: empty response body.`);
    }
  }
  let parsed: JsonRpcResponse;
  try {
    parsed = JSON.parse(candidate) as JsonRpcResponse;
  } catch {
    throw new Error(`n8n MCP ${label}: response was not valid JSON-RPC (got: "${snippet(candidate)}").`);
  }
  if (parsed.error == null && parsed.result === undefined) {
    throw new Error(`n8n MCP ${label}: JSON-RPC envelope had neither result nor error (got: "${snippet(candidate)}").`);
  }
  return parsed;
}

let idCounter = 1;

async function post(
  conn: McpConn,
  body: Record<string, unknown>,
  sessionId?: string,
): Promise<Response> {
  return fetch(conn.url, {
    method: "POST",
    headers: headers(conn, sessionId),
    body: JSON.stringify(body),
  });
}

/** Perform the initialize handshake; returns the session id if the server sets one. */
async function initialize(conn: McpConn): Promise<string | undefined> {
  const res = await post(conn, {
    jsonrpc: "2.0",
    id: idCounter++,
    method: "initialize",
    params: {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: CLIENT_INFO,
    },
  });
  if (!res.ok) {
    throw new Error(`n8n MCP initialize failed: HTTP ${res.status}`);
  }
  const body = await parseResponse(res, "initialize");
  if (body.error) {
    throw new Error(
      `n8n MCP initialize error: ${body.error.message ?? JSON.stringify(body.error)}`,
    );
  }
  const sessionId = res.headers.get("mcp-session-id") ?? undefined;
  // Best-effort initialized notification (no id = notification, no response expected).
  try {
    await post(
      conn,
      { jsonrpc: "2.0", method: "notifications/initialized" },
      sessionId,
    );
  } catch {
    /* notification failures are non-fatal */
  }
  return sessionId;
}

interface McpToolContent {
  type?: string;
  text?: string;
}
interface McpToolResult {
  content?: McpToolContent[];
  structuredContent?: unknown;
  isError?: boolean;
}

/** Join all text content blocks from an MCP tool result. */
function extractText(result: McpToolResult | undefined): string {
  if (!result?.content) return "";
  return result.content
    .filter((c) => c.type === "text" || typeof c.text === "string")
    .map((c) => c.text ?? "")
    .join("\n")
    .trim();
}

/** Best-effort structured payload: prefer structuredContent, else parse the text as JSON. */
function extractData(result: McpToolResult | undefined): unknown {
  if (result?.structuredContent !== undefined) return result.structuredContent;
  const text = extractText(result);
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export interface N8nToolResult {
  /** Raw MCP tool result object. */
  raw: McpToolResult;
  /** Concatenated text content. */
  text: string;
  /** Parsed structured payload (structuredContent or JSON-parsed text), or null. */
  data: unknown;
}

/**
 * Call a named tool on the n8n MCP server. Throws on transport error, JSON-RPC
 * error, or a tool result flagged isError.
 */
export async function n8nCallTool(
  name: string,
  args: Record<string, unknown> = {},
): Promise<N8nToolResult> {
  const conn = requireConn();
  const sessionId = await initialize(conn);
  const res = await post(
    conn,
    {
      jsonrpc: "2.0",
      id: idCounter++,
      method: "tools/call",
      params: { name, arguments: args },
    },
    sessionId,
  );
  if (!res.ok) {
    throw new Error(`n8n MCP tool "${name}" failed: HTTP ${res.status}`);
  }
  const body = await parseResponse(res, `tool "${name}"`);
  if (body.error) {
    throw new Error(
      `n8n MCP tool "${name}" error: ${body.error.message ?? JSON.stringify(body.error)}`,
    );
  }
  const result = body.result as McpToolResult | undefined;
  if (result?.isError) {
    const msg = extractText(result) || "tool returned isError";
    throw new Error(`n8n tool "${name}" failed: ${msg}`);
  }
  return {
    raw: result ?? {},
    text: extractText(result),
    data: extractData(result),
  };
}

export interface N8nPingResult {
  ok: boolean;
  serverInfo?: { name?: string; version?: string };
  toolCount?: number;
}

/** Health check: initialize + tools/list. Throws on failure. */
export async function n8nPing(): Promise<N8nPingResult> {
  const conn = requireConn();
  const initRes = await post(conn, {
    jsonrpc: "2.0",
    id: idCounter++,
    method: "initialize",
    params: {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: CLIENT_INFO,
    },
  });
  if (!initRes.ok) throw new Error(`n8n MCP initialize failed: HTTP ${initRes.status}`);
  const initBody = await parseResponse(initRes, "initialize");
  if (initBody.error) {
    throw new Error(
      `n8n MCP initialize error: ${initBody.error.message ?? JSON.stringify(initBody.error)}`,
    );
  }
  const serverInfo = (initBody.result as { serverInfo?: { name?: string; version?: string } } | undefined)
    ?.serverInfo;
  const sessionId = initRes.headers.get("mcp-session-id") ?? undefined;
  try {
    await post(conn, { jsonrpc: "2.0", method: "notifications/initialized" }, sessionId);
  } catch {
    /* non-fatal */
  }
  const listRes = await post(
    conn,
    { jsonrpc: "2.0", id: idCounter++, method: "tools/list", params: {} },
    sessionId,
  );
  if (!listRes.ok) throw new Error(`n8n MCP tools/list failed: HTTP ${listRes.status}`);
  const listBody = await parseResponse(listRes, "tools/list");
  if (listBody.error) {
    throw new Error(
      `n8n MCP tools/list error: ${listBody.error.message ?? JSON.stringify(listBody.error)}`,
    );
  }
  const tools = (listBody.result as { tools?: unknown[] } | undefined)?.tools;
  return {
    ok: true,
    serverInfo,
    toolCount: Array.isArray(tools) ? tools.length : undefined,
  };
}

/** Search workflows in the connected n8n instance. */
export async function n8nSearchWorkflows(opts: {
  query?: string;
  limit?: number;
  projectId?: string;
}): Promise<N8nToolResult> {
  const args: Record<string, unknown> = {};
  if (opts.query) args.query = opts.query;
  if (opts.limit != null) args.limit = opts.limit;
  if (opts.projectId) args.projectId = opts.projectId;
  return n8nCallTool("search_workflows", args);
}

export interface N8nExecuteResult {
  /** Execution id returned by n8n, if present. */
  executionId: string | null;
  text: string;
  data: unknown;
}

/** Best-effort pull of an execution id out of an n8n tool result payload. */
function findExecutionId(data: unknown, text: string): string | null {
  if (data && typeof data === "object") {
    const rec = data as Record<string, unknown>;
    for (const key of ["executionId", "id", "execution_id"]) {
      const v = rec[key];
      if (typeof v === "string" && v) return v;
      if (typeof v === "number") return String(v);
    }
  }
  // Fallback: look for an id-like token in the text payload.
  const m = text.match(/execution\s*id[^0-9A-Za-z]*([0-9A-Za-z-]+)/i);
  return m?.[1] ?? null;
}

/** Execute an n8n workflow by id. Returns the execution id (n8n returns it immediately). */
export async function n8nExecuteWorkflow(opts: {
  workflowId: string;
  inputs?: Record<string, unknown>;
  executionMode?: string;
}): Promise<N8nExecuteResult> {
  const args: Record<string, unknown> = { workflowId: opts.workflowId };
  if (opts.inputs && Object.keys(opts.inputs).length > 0) args.inputs = opts.inputs;
  if (opts.executionMode) args.executionMode = opts.executionMode;
  const out = await n8nCallTool("execute_workflow", args);
  return {
    executionId: findExecutionId(out.data, out.text),
    text: out.text,
    data: out.data,
  };
}

/** Fetch execution details by workflow + execution id. */
export async function n8nGetExecution(opts: {
  workflowId: string;
  executionId: string;
  includeData?: boolean;
}): Promise<N8nToolResult> {
  const args: Record<string, unknown> = {
    workflowId: opts.workflowId,
    executionId: opts.executionId,
  };
  if (opts.includeData != null) args.includeData = opts.includeData;
  return n8nCallTool("get_execution", args);
}
