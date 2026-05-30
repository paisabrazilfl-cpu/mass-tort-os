import { test } from "node:test";
import assert from "node:assert/strict";
import { TORT_REGISTRY, type TortDefinition } from "../tort-engine";
import { buildTortAgentPrompt } from "../voice/tort-agent-prompt";

const ALL = Object.values(TORT_REGISTRY);

test("every tort prompt is MTOS-branded and disclaims being a law firm", () => {
  for (const tort of ALL) {
    const { systemPrompt } = buildTortAgentPrompt(tort);
    assert.match(systemPrompt, /MTOS/, `${tort.id} system prompt should mention MTOS`);
    assert.match(
      systemPrompt,
      /NOT A LAW FIRM/i,
      `${tort.id} system prompt should disclaim being a law firm`,
    );
    assert.match(
      systemPrompt,
      /No legal advice/i,
      `${tort.id} system prompt should forbid legal advice`,
    );
    assert.match(
      systemPrompt,
      /No medical advice/i,
      `${tort.id} system prompt should forbid medical advice`,
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
    "## 0. COMPLIANCE GATE",
    "## 1. IDENTITY & PURPOSE",
    "## 2. VOICE & PERSONA",
    "## 3. CONVERSATION FLOW",
    "## 4. RESPONSE GUIDELINES",
    "## 5. RESPONSE REFINEMENT",
    "## 6. SCENARIO HANDLING",
    "## 7. KNOWLEDGE BASE",
    "## 8. DATA CAPTURE SCHEMA",
    "## 9. DISPOSITION CODES",
    "## 10. HELD-FLAG REFERENCE",
    "## 11. TOOLS",
    "## 12. AGENT NON-NEGOTIABLES",
    "# DISQUALIFIERS",
  ]) {
    assert.ok(systemPrompt.includes(section), `missing section: ${section}`);
  }
  for (const tool of ["lookup-lead", "create-lead", "check-eligibility", "escalate-to-human"]) {
    assert.ok(systemPrompt.includes(tool), `missing tool reference: ${tool}`);
  }
});

test("every prompt resolves the tri-state outcome and lists disposition reason codes", () => {
  for (const tort of ALL) {
    const { systemPrompt } = buildTortAgentPrompt(tort);
    for (const state of ["QUALIFIED", "HELD", "DISQUALIFIED"]) {
      assert.ok(systemPrompt.includes(state), `${tort.id} missing tri-state ${state}`);
    }
    // Registry rejection codes must surface in the disqualifier/disposition copy.
    for (const code of tort.rejection_conditions) {
      assert.ok(
        systemPrompt.includes(code),
        `${tort.id} should surface reason code ${code}`,
      );
    }
  }
});

test("exposure-required torts state exposure is required; non-exposure torts do not invent a hard requirement", () => {
  for (const tort of ALL) {
    const { systemPrompt } = buildTortAgentPrompt(tort);
    if (tort.required_exposure) {
      assert.match(
        systemPrompt,
        /Exposure\/use is REQUIRED/i,
        `${tort.id} requires exposure but prompt does not say so`,
      );
    } else {
      assert.ok(
        !/Exposure\/use is REQUIRED/i.test(systemPrompt),
        `${tort.id} does not require exposure but prompt marks it required`,
      );
    }
  }
});

test("camp lejeune prompt encodes the 1953-1987 coverage window", () => {
  const cl = TORT_REGISTRY["camp-lejeune"];
  assert.ok(cl, "camp-lejeune tort should exist");
  const { systemPrompt } = buildTortAgentPrompt(cl);
  assert.match(systemPrompt, /1953 and 1987/, "camp lejeune should encode the coverage window");
});

test("no-diagnosis, no-exposure tort uses the descriptive injury branch without inventing requirements", () => {
  // No current registry entry has an empty diagnosis list; this synthetic tort
  // locks in the descriptive Gate A branch and the non-required exposure copy.
  const synthetic: TortDefinition = {
    id: "synthetic-no-dx",
    label: "Synthetic No-Dx Matter",
    category: "digital_platform",
    valid_diagnoses: [],
    required_exposure: false,
    exposure_fields: [],
    extra_fields: [],
    rules: [],
    rejection_conditions: [],
  };
  const { systemPrompt, firstMessage } = buildTortAgentPrompt(synthetic);
  // Descriptive Gate A (no qualifying-list wording).
  assert.match(systemPrompt, /There is no fixed diagnosis list/i);
  assert.ok(!/Qualifying conditions for/.test(systemPrompt), "should not claim a qualifying list");
  // Must not invent a hard exposure requirement.
  assert.ok(!/Exposure\/use is REQUIRED/i.test(systemPrompt), "should not mark exposure required");
  // Branding + structure still hold.
  assert.match(systemPrompt, /NOT A LAW FIRM/);
  assert.match(systemPrompt, /## 0\. COMPLIANCE GATE/);
  assert.match(firstMessage, /MTOS/);
});
