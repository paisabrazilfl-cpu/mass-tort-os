// Validation tests for the AI Assist endpoint's catalog guard. We exercise
// the pure functions (no LLM, no HTTP) so the test is fast and deterministic.
// The real value here: catch any catalog drift that would let the assistant
// silently propose unknown nodes or impossible branch edges.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { __assistInternals } from "../../routes/automations.js";

const { validateAssistGraph, buildCatalogSummary, assistGraphSchema } = __assistInternals;

describe("automations.assist validateAssistGraph", () => {
  test("accepts a minimal valid graph", () => {
    const graph = assistGraphSchema.parse({
      nodes: [
        { id: "t1", type: "trigger.manual", position: { x: 0, y: 0 }, data: { label: "Start" } },
        { id: "e1", type: "utility.end", position: { x: 200, y: 0 }, data: { label: "End" } },
      ],
      edges: [{ id: "e_t1_e1", source: "t1", target: "e1" }],
    });
    assert.deepEqual(validateAssistGraph(graph), { issues: [], warnings: [] });
  });

  test("rejects unknown node types", () => {
    const graph = assistGraphSchema.parse({
      nodes: [{ id: "x1", type: "made.up.node", position: { x: 0, y: 0 } }],
      edges: [],
    });
    const { issues } = validateAssistGraph(graph);
    assert.equal(issues.length, 1);
    assert.match(issues[0]!, /Unknown node type "made\.up\.node"/);
  });

  test("rejects edges pointing at missing nodes", () => {
    const graph = assistGraphSchema.parse({
      nodes: [{ id: "t1", type: "trigger.manual", position: { x: 0, y: 0 } }],
      edges: [{ id: "bad", source: "t1", target: "nope" }],
    });
    const { issues } = validateAssistGraph(graph);
    assert.ok(issues.some((i: string) => i.includes('target "nope"')));
  });

  test("rejects sourceHandle that is not declared on the node's outputs", () => {
    // crm.background_check declares outputs ["clear","flagged","error"].
    const graph = assistGraphSchema.parse({
      nodes: [
        { id: "t1", type: "trigger.manual", position: { x: 0, y: 0 } },
        { id: "bg", type: "crm.background_check", position: { x: 200, y: 0 } },
        { id: "end", type: "utility.end", position: { x: 400, y: 0 } },
      ],
      edges: [
        { id: "e1", source: "t1", target: "bg" },
        { id: "e2", source: "bg", target: "end", sourceHandle: "totally_made_up" },
      ],
    });
    const { issues } = validateAssistGraph(graph);
    assert.ok(issues.some((i: string) => i.includes("totally_made_up")));
  });

  test("accepts valid named branch edges", () => {
    const graph = assistGraphSchema.parse({
      nodes: [
        { id: "t1", type: "trigger.manual", position: { x: 0, y: 0 } },
        { id: "bg", type: "crm.background_check", position: { x: 200, y: 0 } },
        { id: "end", type: "utility.end", position: { x: 400, y: 0 } },
      ],
      edges: [
        { id: "e1", source: "t1", target: "bg" },
        { id: "e2", source: "bg", target: "end", sourceHandle: "clear" },
      ],
    });
    assert.deepEqual(validateAssistGraph(graph), { issues: [], warnings: [] });
  });

  test("strips unknown params keys (catalog allowlist) and emits a warning", () => {
    // crm.background_check declares params [leadId, lanes]. Anything else
    // is now silently stripped (and reported via `warnings`) rather than
    // failing the whole graph — LLMs occasionally hallucinate edge-level
    // fields like `sourceHandle` into a node's params block.
    const graph = assistGraphSchema.parse({
      nodes: [
        { id: "t1", type: "trigger.manual", position: { x: 0, y: 0 } },
        { id: "bg", type: "crm.background_check", position: { x: 200, y: 0 }, data: { params: { leadId: "1", lanes: ["ofac"], madeUpKey: "x" } } },
      ],
      edges: [{ id: "e1", source: "t1", target: "bg" }],
    });
    const { issues, warnings } = validateAssistGraph(graph);
    assert.deepEqual(issues, []);
    assert.ok(warnings.some((w: string) => w.includes("madeUpKey")));
    // The bad key was actually removed from the graph.
    const bg = graph.nodes.find((n) => n.id === "bg");
    assert.equal((bg?.data?.params as Record<string, unknown> | undefined)?.madeUpKey, undefined);
    assert.equal((bg?.data?.params as Record<string, unknown> | undefined)?.leadId, "1");
  });

  test("accepts only declared param keys", () => {
    const graph = assistGraphSchema.parse({
      nodes: [
        { id: "t1", type: "trigger.manual", position: { x: 0, y: 0 } },
        { id: "io", type: "io.read_file", position: { x: 200, y: 0 }, data: { params: { key: "case-1/notes.txt" } } },
      ],
      edges: [{ id: "e1", source: "t1", target: "io" }],
    });
    assert.deepEqual(validateAssistGraph(graph), { issues: [], warnings: [] });
  });

  test("rejects duplicate node ids", () => {
    const graph = assistGraphSchema.parse({
      nodes: [
        { id: "dup", type: "trigger.manual", position: { x: 0, y: 0 } },
        { id: "dup", type: "utility.end", position: { x: 200, y: 0 } },
      ],
      edges: [],
    });
    const { issues } = validateAssistGraph(graph);
    assert.ok(issues.some((i: string) => i.includes("Duplicate node id")));
  });

  test("auto-fills missing edge ids from source→target", () => {
    // Verifies the schema-level transform that synthesizes edge ids when
    // the LLM omits them (common — React Flow generates ids client-side).
    const graph = assistGraphSchema.parse({
      nodes: [
        { id: "t1", type: "trigger.manual", position: { x: 0, y: 0 } },
        { id: "end", type: "utility.end", position: { x: 200, y: 0 } },
      ],
      edges: [{ source: "t1", target: "end" }],
    });
    assert.equal(graph.edges.length, 1);
    assert.ok(graph.edges[0]!.id && graph.edges[0]!.id.length > 0);
  });
});

describe("automations.assist buildCatalogSummary", () => {
  test("includes branching outputs verbatim for the model", () => {
    const summary = buildCatalogSummary();
    // crm.background_check has outputs ["clear","flagged","error"] — must
    // appear verbatim so the model knows the exact branch names to emit.
    assert.match(summary, /crm\.background_check \[clear\|flagged\|error\]/);
    // logic.if has ["true","false"]
    assert.match(summary, /logic\.if \[true\|false\]/);
  });

  test("groups by category", () => {
    const summary = buildCatalogSummary();
    assert.match(summary, /\[trigger\]/);
    assert.match(summary, /\[crm\]/);
    assert.match(summary, /\[ai\]/);
  });
});
