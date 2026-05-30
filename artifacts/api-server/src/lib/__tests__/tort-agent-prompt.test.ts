import { test } from "node:test";
import assert from "node:assert/strict";
import { TORT_REGISTRY } from "../tort-engine";
import { buildTortAgentPrompt } from "../voice/tort-agent-prompt";

const ALL = Object.values(TORT_REGISTRY);

test("every tort prompt is MTOS-branded and disclaims being a law firm", () => {
  for (const tort of ALL) {
    const { systemPrompt } = buildTortAgentPrompt(tort);
    assert.match(systemPrompt, /MTOS/, `${tort.id} system prompt should mention MTOS`);
    assert.match(
      systemPrompt,
      /NOT a law firm/i,
      `${tort.id} system prompt should disclaim being a law firm`,
    );
    assert.match(
      systemPrompt,
      /never give legal advice/i,
      `${tort.id} system prompt should forbid legal advice`,
    );
  }
});

test("no prompt positively frames MTOS as a law firm or lawyer", () => {
  // Positive framings that would falsely present MTOS as a firm/representation.
  const badFraming =
    /(a mass tort law firm|from a law firm|we are a law firm|we're a law firm|our law firm|your law firm|our firm|your attorney|your lawyer|we represent you)/i;
  for (const tort of ALL) {
    const { systemPrompt, firstMessage } = buildTortAgentPrompt(tort);
    assert.doesNotMatch(systemPrompt, badFraming, `${tort.id} system prompt has law-firm framing`);
    assert.doesNotMatch(firstMessage, badFraming, `${tort.id} first message has law-firm framing`);
    assert.match(firstMessage, /MTOS/, `${tort.id} first message should mention MTOS`);
  }
});

test("prompt includes the full intake script sections and tool order", () => {
  const sample = ALL[0];
  const { systemPrompt } = buildTortAgentPrompt(sample);
  for (const section of [
    "# ROLE",
    "# PRIME DIRECTIVE",
    "# LANGUAGE",
    "# TONE & DELIVERY",
    "# QUALIFYING CHECKLIST",
    "# TOOLS",
    "# ELIGIBILITY DECISION",
    "# DISQUALIFIERS",
    "# CONVERSATION STYLE",
    "# DATA QUALITY",
    "# COMPLIANCE & SAFETY",
    "# CLOSING / NEXT STEPS",
  ]) {
    assert.ok(systemPrompt.includes(section), `missing section: ${section}`);
  }
  for (const tool of ["lookup-lead", "create-lead", "check-eligibility", "escalate-to-human"]) {
    assert.ok(systemPrompt.includes(tool), `missing tool reference: ${tool}`);
  }
});
