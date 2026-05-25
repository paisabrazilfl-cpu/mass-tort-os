/**
 * Unit tests for the autonomous-agent pure logic (lib/automations/agent.ts).
 *
 * These exercise the planner-reply parser and the tool access classifier —
 * the two pieces that gate every agent step — with no DB and no network, so
 * they run in any environment. The risks they guard:
 *   - a brittle parser would mis-route a valid model reply, stalling the loop;
 *   - a too-loose parser would treat prose as an action and call a junk tool;
 *   - a mis-classified write tool would execute for real during a dry run.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseAgentAction,
  classifyToolAccess,
  AGENT_READ_TOOLS,
} from "../automations/agent";

// ── parseAgentAction: tool actions ──────────────────────────────────────────

test("parses a canonical action reply", () => {
  const r = parseAgentAction(
    '{"thought":"look up the lead","action":{"tool":"io.sql_query","params":{"sql":"SELECT 1"}}}',
  );
  assert.equal(r.ok, true);
  assert.equal(r.ok && r.kind, "action");
  assert.equal(r.ok && r.kind === "action" && r.tool, "io.sql_query");
  assert.deepEqual(r.ok && r.kind === "action" && r.params, { sql: "SELECT 1" });
});

test("parses a flattened action reply (no nested action key)", () => {
  const r = parseAgentAction('{"thought":"go","tool":"crm.add_note","params":{"note":"hi"}}');
  assert.equal(r.ok && r.kind === "action" && r.tool, "crm.add_note");
});

test("strips a ```json markdown fence around the action", () => {
  const r = parseAgentAction('```json\n{"action":{"tool":"utility.log","params":{}}}\n```');
  assert.equal(r.ok && r.kind === "action" && r.tool, "utility.log");
});

test("tolerates prose before and after the JSON object", () => {
  const r = parseAgentAction(
    'Sure, here is my next step:\n{"action":{"tool":"ai.draft","params":{"prompt":"x"}}}\nDone.',
  );
  assert.equal(r.ok && r.kind === "action" && r.tool, "ai.draft");
});

test("defaults params to an empty object when omitted", () => {
  const r = parseAgentAction('{"action":{"tool":"utility.log"}}');
  assert.deepEqual(r.ok && r.kind === "action" && r.params, {});
});

// ── parseAgentAction: final answers ─────────────────────────────────────────

test("parses an object final answer with summary + result", () => {
  const r = parseAgentAction(
    '{"thought":"done","final":{"summary":"lead qualified","result":{"lead_id":7}}}',
  );
  assert.equal(r.ok && r.kind, "final");
  assert.equal(r.ok && r.kind === "final" && r.summary, "lead qualified");
  assert.deepEqual(r.ok && r.kind === "final" && r.result, { lead_id: 7 });
});

test("parses a bare-string final answer", () => {
  const r = parseAgentAction('{"final":"nothing left to do"}');
  assert.equal(r.ok && r.kind === "final" && r.summary, "nothing left to do");
});

test("treats done:true as a final answer", () => {
  const r = parseAgentAction('{"done":true,"summary":"complete"}');
  assert.equal(r.ok && r.kind, "final");
});

// ── parseAgentAction: rejects garbage ───────────────────────────────────────

test("rejects an empty reply", () => {
  assert.equal(parseAgentAction("").ok, false);
  assert.equal(parseAgentAction("   ").ok, false);
});

test("rejects a reply with no JSON object", () => {
  assert.equal(parseAgentAction("I think I should call a tool now.").ok, false);
});

test("rejects malformed JSON", () => {
  assert.equal(parseAgentAction('{"action":{"tool":').ok, false);
});

test("rejects a JSON object that is neither an action nor a final answer", () => {
  assert.equal(parseAgentAction('{"thought":"just thinking out loud"}').ok, false);
});

// ── classifyToolAccess ──────────────────────────────────────────────────────

test("read-only tools classify as read", () => {
  for (const t of ["io.sql_query", "io.read_file", "ai.draft", "crm.npi_lookup", "data.set"]) {
    assert.equal(classifyToolAccess(t), "read", `${t} must be read`);
  }
});

test("side-effecting tools classify as write", () => {
  for (const t of [
    "crm.update_lead",
    "crm.create_lead",
    "comm.send_sms",
    "integration.send_email",
    "documents.fax_medical_records",
    "io.write_file",
    "script.bash",
  ]) {
    assert.equal(classifyToolAccess(t), "write", `${t} must be write`);
  }
});

test("unknown tool types default to write (conservative)", () => {
  assert.equal(classifyToolAccess("some.unrecognized_node"), "write");
});

test("AGENT_READ_TOOLS and classifyToolAccess agree", () => {
  for (const t of AGENT_READ_TOOLS) {
    assert.equal(classifyToolAccess(t), "read", `${t} is in AGENT_READ_TOOLS but classified write`);
  }
});
