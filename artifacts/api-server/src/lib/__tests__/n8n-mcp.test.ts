// n8n MCP bridge: connection-gate, per-firm isolation, and honest-failure contract.
// These run without network — they assert that:
//   1. n8nConfigured() honestly reflects the GLOBAL env instance,
//   2. selectN8nConn() enforces per-firm credential isolation (a firm-scoped
//      run NEVER falls back to the owner's global env instance), and
//   3. the client refuses to treat an unparseable 200 as a clean result.

import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  n8nConfigured,
  readEnvConn,
  selectN8nConn,
  n8nCallTool,
  type McpConn,
} from "../automations/n8n-mcp.js";

const KEYS = ["N8N_MCP_URL", "N8N_MCP_TOKEN"] as const;
const TEST_CONN: McpConn = { url: "https://example.app.n8n.cloud/mcp-server/http", token: "test-token" };

describe("n8n MCP bridge: global env connection gate", () => {
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const k of KEYS) saved[k] = process.env[k];
  });
  afterEach(() => {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  test("n8nConfigured() / readEnvConn() are false/null when env is missing", () => {
    delete process.env["N8N_MCP_URL"];
    delete process.env["N8N_MCP_TOKEN"];
    assert.equal(n8nConfigured(), false);
    assert.equal(readEnvConn(), null);
  });

  test("n8nConfigured() is false when only one of the pair is set", () => {
    process.env["N8N_MCP_URL"] = "https://example.app.n8n.cloud/mcp-server/http";
    delete process.env["N8N_MCP_TOKEN"];
    assert.equal(n8nConfigured(), false);
    assert.equal(readEnvConn(), null);
  });

  test("n8nConfigured() / readEnvConn() reflect both vars when set", () => {
    process.env["N8N_MCP_URL"] = "https://example.app.n8n.cloud/mcp-server/http";
    process.env["N8N_MCP_TOKEN"] = "test-token";
    assert.equal(n8nConfigured(), true);
    assert.deepEqual(readEnvConn(), {
      url: "https://example.app.n8n.cloud/mcp-server/http",
      token: "test-token",
    });
  });
});

describe("selectN8nConn: per-firm credential isolation", () => {
  const envConn: McpConn = { url: "https://owner.app.n8n.cloud/mcp-server/http", token: "owner-token" };
  const firmConn: McpConn = { url: "https://firm.app.n8n.cloud/mcp-server/http", token: "firm-token" };

  test("system run (firmId null) uses the global env connection", () => {
    assert.deepEqual(selectN8nConn({ firmId: null, envConn, firmConn: null }), envConn);
  });

  test("system run (firmId null) with no env connection THROWS", () => {
    assert.throws(
      () => selectN8nConn({ firmId: null, envConn: null, firmConn: null }),
      /not connected for system-scope/,
    );
  });

  test("firm run uses the firm's OWN vault connection", () => {
    assert.deepEqual(selectN8nConn({ firmId: 42, envConn, firmConn }), firmConn);
  });

  test("firm run with no firm connection THROWS and NEVER uses the owner's env connection", () => {
    // This is the security invariant: even though a global env instance is
    // present, a firm-scoped run that has no own connection must fail honestly
    // rather than reach across the tenancy boundary to the owner's n8n.
    assert.throws(
      () => selectN8nConn({ firmId: 42, envConn, firmConn: null }),
      /Firm 42 has no n8n connection configured/,
    );
  });
});

describe("n8n MCP bridge: strict response parsing (honesty invariant)", () => {
  const realFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  // The initialize handshake always succeeds; we only vary the tools/call body.
  function stubFetch(toolCallResponse: Response): void {
    let call = 0;
    globalThis.fetch = (async () => {
      call += 1;
      if (call === 1) {
        // initialize → valid JSON-RPC result
        return new Response(
          JSON.stringify({ jsonrpc: "2.0", id: 1, result: { serverInfo: { name: "n8n", version: "1.0.0" } } }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (call === 2) {
        // notifications/initialized → ignored
        return new Response("", { status: 202 });
      }
      // tools/call → the body under test
      return toolCallResponse;
    }) as typeof fetch;
  }

  test("non-JSON 200 (HTML error page) THROWS, not silent success", async () => {
    stubFetch(
      new Response("<html><body>Bad Gateway</body></html>", {
        status: 200,
        headers: { "content-type": "text/html" },
      }),
    );
    await assert.rejects(() => n8nCallTool(TEST_CONN, "search_workflows"), /not valid JSON-RPC/);
  });

  test("empty 200 body THROWS", async () => {
    stubFetch(new Response("", { status: 200, headers: { "content-type": "application/json" } }));
    await assert.rejects(() => n8nCallTool(TEST_CONN, "search_workflows"), /empty response body/);
  });

  test("JSON-RPC envelope with neither result nor error THROWS", async () => {
    stubFetch(
      new Response(JSON.stringify({ jsonrpc: "2.0", id: 2 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    await assert.rejects(() => n8nCallTool(TEST_CONN, "search_workflows"), /neither result nor error/);
  });

  test("SSE stream with no data frame THROWS", async () => {
    stubFetch(
      new Response(": keep-alive\n\n", {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      }),
    );
    await assert.rejects(() => n8nCallTool(TEST_CONN, "search_workflows"), /no data frame/);
  });

  test("valid tool result is returned (control case)", async () => {
    stubFetch(
      new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 2,
          result: { content: [{ type: "text", text: '{"ok":true}' }] },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    const out = await n8nCallTool(TEST_CONN, "search_workflows");
    assert.deepEqual(out.data, { ok: true });
  });
});
