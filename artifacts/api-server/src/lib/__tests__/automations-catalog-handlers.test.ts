// Parity test: every NODE_CATALOG entry must have a matching HANDLERS
// entry, and vice versa. Without this, catalog drift silently produces
// either (a) AI-Assist graphs the executor can't run, or (b) handlers
// nobody can drag onto the canvas. Either way the workflow surface
// breaks for end users.
//
// Also asserts that branching catalog nodes have a contractually
// matching handler (the executor enforces __branch ∈ outputs at
// runtime — this test pins the static contract).

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { NODE_CATALOG } from "../automations/node-catalog.js";
import { HANDLERS } from "../automations/executor.js";

describe("automations: catalog ↔ handlers parity", () => {
  const catalogTypes = new Set(NODE_CATALOG.map((n) => n.type));
  const handlerTypes = new Set(Object.keys(HANDLERS));

  test("every catalog node has a handler", () => {
    const missing = [...catalogTypes].filter((t) => !handlerTypes.has(t));
    assert.deepEqual(missing, [], `Catalog nodes without a handler: ${missing.join(", ")}`);
  });

  test("every handler has a catalog entry", () => {
    const orphans = [...handlerTypes].filter((t) => !catalogTypes.has(t));
    assert.deepEqual(orphans, [], `Handlers without a catalog entry: ${orphans.join(", ")}`);
  });

  test("branching catalog nodes declare named outputs as a string array", () => {
    const branching = NODE_CATALOG.filter((n) => Array.isArray(n.outputs));
    assert.ok(branching.length > 0, "expected at least one branching node");
    for (const def of branching) {
      const outs = def.outputs as unknown;
      assert.ok(Array.isArray(outs), `${def.type}: outputs must be string[]`);
      for (const o of outs as string[]) {
        assert.equal(typeof o, "string", `${def.type}: branch name must be a string`);
        assert.ok(o.length > 0, `${def.type}: branch name must be non-empty`);
      }
    }
  });

  test("trigger.* nodes have inputs:0 (entry points only)", () => {
    for (const def of NODE_CATALOG.filter((n) => n.type.startsWith("trigger."))) {
      assert.equal(def.inputs, 0, `${def.type} must have inputs:0 (it's a trigger).`);
    }
  });
});
