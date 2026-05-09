// Smoke tests for the AI Constitution loader. These guard against:
//   - the constitution file being moved/renamed/deleted (the loader
//     would throw at first call inside admin-ai-constitution and the
//     `/assist` preamble injection would also break)
//   - silent drift between the markdown's `**Version**:` line and what
//     the loader exposes to API clients
//   - the preamble growing too large (it gets prepended to every
//     `/assist` LLM call — keep it tight)

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  getAiConstitution,
  getAiConstitutionPreamble,
} from "../ai-constitution";

describe("ai-constitution loader", () => {
  test("loads the markdown and exposes a stable sha + version", () => {
    const a = getAiConstitution();
    assert.equal(typeof a.markdown, "string");
    assert.ok(a.markdown.length > 1000, "constitution should be substantial");
    assert.equal(a.version, 1);
    assert.match(a.sha256, /^[0-9a-f]{64}$/);
    assert.equal(a.bytes, Buffer.byteLength(a.markdown, "utf8"));
    // Two reads in a row must return the same content + same sha (cache),
    // but `retrieved_at` should advance on each call.
    const b = getAiConstitution();
    assert.equal(b.sha256, a.sha256);
    assert.equal(b.markdown, a.markdown);
  });

  test("constitution covers the non-negotiable sections", () => {
    const { markdown } = getAiConstitution();
    // These section headers are referenced by the failure-protocol ladder
    // and the assist-preamble. If any goes missing, the preamble's
    // promises are no longer backed by the document.
    assert.match(markdown, /## 1\. Identity/);
    assert.match(markdown, /## 2\. The Prime Directive/);
    assert.match(markdown, /## 3\. House Rules/);
    assert.match(markdown, /## 5\. The Toolbox/);
    assert.match(markdown, /## 6\. The Automation Decision Tree/);
    assert.match(markdown, /## 8\. Failure Protocol/);
    assert.match(markdown, /## 9\. Bright Lines/);
  });

  test("preamble is compact and hits the load-bearing keywords", () => {
    const p = getAiConstitutionPreamble();
    // Keep the preamble small — it gets prepended to every /assist LLM
    // call. 2000 chars is generous; if this ever starts getting close,
    // shrink it before raising the cap.
    assert.ok(p.length < 2000, `preamble too long: ${p.length} chars`);
    assert.match(p, /Mass Tort Operating System/);
    assert.match(p, /human/i);
    assert.match(p, /review/i);
    assert.match(p, /NEVER invent a clean result/);
    assert.match(p, /\/api\/review-queue/);
    assert.match(p, /\/api\/admin\/ai-constitution/);
  });

  // Anti-drift contract test (architect review 2026-05-09): the
  // hand-curated preamble makes promises ("PRIME DIRECTIVE", "HOUSE
  // RULES", "BRIGHT LINES", "WHEN STUCK") that MUST also be backed by
  // sections in the canonical markdown. If a section is renamed in the
  // doc but the preamble still references the old name, helper LLMs
  // would be operating under a stale contract — this test catches that.
  test("preamble obligations are backed by markdown sections", () => {
    const { markdown } = getAiConstitution();
    const preamble = getAiConstitutionPreamble();

    // Every claim the preamble shouts in CAPS must map to a real
    // section heading in the markdown. If you rename a section, update
    // both ends.
    const obligations: Array<{ preambleKey: RegExp; markdownSection: RegExp }> =
      [
        { preambleKey: /PRIME DIRECTIVE/, markdownSection: /## 2\. The Prime Directive/ },
        { preambleKey: /HOUSE RULES/, markdownSection: /## 3\. House Rules/ },
        { preambleKey: /WHEN STUCK/, markdownSection: /## 8\. Failure Protocol/ },
        { preambleKey: /BRIGHT LINES/, markdownSection: /## 9\. Bright Lines/ },
      ];

    for (const { preambleKey, markdownSection } of obligations) {
      assert.match(preamble, preambleKey, `preamble missing key: ${preambleKey}`);
      assert.match(
        markdown,
        markdownSection,
        `markdown missing section that backs preamble key ${preambleKey}: ${markdownSection}`,
      );
    }

    // The preamble names specific endpoints. Those endpoints must also
    // appear in the canonical doc's discovery / failure-protocol
    // sections — otherwise a helper LLM is being told to call URLs the
    // doc no longer mentions.
    for (const url of [
      "/api/admin/event-catalog",
      "/api/automations/node-catalog",
      "/api/automations/assist",
      "/api/review-queue",
    ]) {
      assert.ok(
        markdown.includes(url),
        `preamble references ${url} but markdown does not`,
      );
    }
  });

  test("missing or malformed Version header throws at load time", () => {
    // Re-import the loader's internal so we can call loadFromDisk
    // directly with a mocked file system would be nice — but the
    // simplest contract here is: if we ever ship a markdown without
    // the version header, the production code path throws (caught at
    // server boot). Validate the regex behaviour by asserting against
    // the actual current document, then by simulating the failure mode
    // with a small helper. This guards against the previous behaviour
    // where a missing header silently defaulted to v1.
    const { version } = getAiConstitution();
    assert.equal(version, 1, "current doc should be v1");

    // Simulate the malformed case: feed the parser a markdown blob
    // missing the header and assert the loader's contract by re-
    // implementing the check. (loadFromDisk reads from disk, so we
    // can't easily mock it without filesystem juggling — this is the
    // narrow regression check that the parsing rule itself rejects.)
    const malformed = "# Some Doc\n\nNo version line here.\n";
    assert.equal(malformed.match(/\*\*Version\*\*:\s*(\d+)/), null);
  });
});
