// n8n MCP bridge: connection-gate + honest-failure contract.
// These run without network — they only assert that the client refuses to
// pretend it's connected when N8N_MCP_URL / N8N_MCP_TOKEN are absent, and
// that a missing connection THROWS (honesty invariant) rather than returning
// a clean-looking empty result.

import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  n8nConfigured,
  n8nExecuteWorkflow,
  n8nPing,
  n8nSearchWorkflows,
  n8nCallTool,
} from "../automations/n8n-mcp.js";

const KEYS = ["N8N_MCP_URL", "N8N_MCP_TOKEN"] as const;

describe("n8n MCP bridge: connection gate", () => {
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

  test("n8nConfigured() is false when env is missing", () => {
    delete process.env["N8N_MCP_URL"];
    delete process.env["N8N_MCP_TOKEN"];
    assert.equal(n8nConfigured(), false);
  });

  test("n8nConfigured() is false when only one of the pair is set", () => {
    process.env["N8N_MCP_URL"] = "https://example.app.n8n.cloud/mcp-server/http";
    delete process.env["N8N_MCP_TOKEN"];
    assert.equal(n8nConfigured(), false);
  });

  test("n8nConfigured() is true when both are set", () => {
    process.env["N8N_MCP_URL"] = "https://example.app.n8n.cloud/mcp-server/http";
    process.env["N8N_MCP_TOKEN"] = "test-token";
    assert.equal(n8nConfigured(), true);
  });

  test("calls throw (not silently succeed) when not connected", async () => {
    delete process.env["N8N_MCP_URL"];
    delete process.env["N8N_MCP_TOKEN"];
    await assert.rejects(
      () => n8nExecuteWorkflow({ workflowId: "1" }),
      /n8n is not connected/,
    );
    await assert.rejects(() => n8nPing(), /n8n is not connected/);
    await assert.rejects(() => n8nSearchWorkflows({}), /n8n is not connected/);
  });
});

describe("n8n MCP bridge: strict response parsing (honesty invariant)", () => {
  const saved: Record<string, string | undefined> = {};
  const realFetch = globalThis.fetch;

  beforeEach(() => {
    for (const k of KEYS) saved[k] = process.env[k];
    process.env["N8N_MCP_URL"] = "https://example.app.n8n.cloud/mcp-server/http";
    process.env["N8N_MCP_TOKEN"] = "test-token";
  });
  afterEach(() => {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
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
    await assert.rejects(() => n8nCallTool("search_workflows"), /not valid JSON-RPC/);
  });

  test("empty 200 body THROWS", async () => {
    stubFetch(new Response("", { status: 200, headers: { "content-type": "application/json" } }));
    await assert.rejects(() => n8nCallTool("search_workflows"), /empty response body/);
  });

  test("JSON-RPC envelope with neither result nor error THROWS", async () => {
    stubFetch(
      new Response(JSON.stringify({ jsonrpc: "2.0", id: 2 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    await assert.rejects(() => n8nCallTool("search_workflows"), /neither result nor error/);
  });

  test("SSE stream with no data frame THROWS", async () => {
    stubFetch(
      new Response(": keep-alive\n\n", {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      }),
    );
    await assert.rejects(() => n8nCallTool("search_workflows"), /no data frame/);
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
    const out = await n8nCallTool("search_workflows");
    assert.deepEqual(out.data, { ok: true });
  });
});
