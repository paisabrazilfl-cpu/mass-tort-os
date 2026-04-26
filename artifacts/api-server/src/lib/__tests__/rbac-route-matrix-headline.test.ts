// Unit test for the headline-count gate added to scripts/check-rbac-route-matrix.sh.
//
// The bash gate diffs the per-route table embedded in
//   docs/audits/rbac-remediation-2026-04-26.md (Section 11)
// against the live express tree, AND now also checks that the
// "Boot-time count: **N checked / P public / Q protected / R unprotected.**"
// headline prose just above the table matches the live counts emitted by
// validateRouteTable. This test points the gate at a mutated copy of the
// audit doc (count silently bumped from N to N+1) and asserts the gate
// fails with a clear "Section 11 headline count is stale" message — the
// drift the upstream Task #28 fixture set out to catch.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// Resolve the repo root from this file: artifacts/api-server/src/lib/__tests__ → ../../../../..
const ROOT = resolve(import.meta.dirname ?? __dirname, "../../../../..");
const SCRIPT = join(ROOT, "scripts/check-rbac-route-matrix.sh");
const REAL_AUDIT_DOC = join(ROOT, "docs/audits/rbac-remediation-2026-04-26.md");

function runGate(auditDocPath: string): { status: number; stdout: string; stderr: string } {
  const r = spawnSync("bash", [SCRIPT], {
    cwd: ROOT,
    env: { ...process.env, AUDIT_DOC: auditDocPath, LOG_LEVEL: "silent" },
    encoding: "utf8",
    // The gate spawns pnpm + tsx + walks the express tree; ~5s wall on
    // current CI hardware. 60s is generous headroom.
    timeout: 60_000,
  });
  return {
    status: r.status ?? -1,
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? "",
  };
}

describe("scripts/check-rbac-route-matrix.sh — Section 11 headline count gate (Task #28)", () => {
  test("FAILS when the 'Boot-time count' headline above the per-route table drifts from the live counts", () => {
    const tmp = mkdtempSync(join(tmpdir(), "rbac-headline-"));
    try {
      const fixture = join(tmp, "audit.md");
      const original = readFileSync(REAL_AUDIT_DOC, "utf8");

      // Mutate ONLY the headline count line — bump every integer in it
      // by 1 so the prose silently lies about the live route table while
      // the table itself remains in sync. This is the exact failure mode
      // Task #28 was opened to prevent: a contributor regenerates the
      // table but forgets the prose count just above it.
      const headlineRe = /^Boot-time count: \*\*(\d+) checked \/ (\d+) public \/ (\d+) protected \/ (\d+) unprotected\.\*\*$/m;
      const match = headlineRe.exec(original);
      assert.ok(match, "fixture invariant: real audit doc must contain a 'Boot-time count' headline");
      const mutated = original.replace(
        headlineRe,
        (_full, c, p, q, u) =>
          `Boot-time count: **${Number(c) + 1} checked / ${Number(p) + 1} public / ${Number(q) + 1} protected / ${Number(u) + 1} unprotected.**`,
      );
      assert.notEqual(mutated, original, "fixture invariant: mutation must change the doc");
      writeFileSync(fixture, mutated, "utf8");

      const r = runGate(fixture);
      assert.notEqual(r.status, 0, `expected gate to FAIL on mutated headline, got exit ${r.status}\n--- stdout ---\n${r.stdout}\n--- stderr ---\n${r.stderr}`);
      assert.match(
        r.stderr,
        /Section 11 headline count is stale/,
        `expected stderr to call out the stale headline, got:\n${r.stderr}`,
      );
      // Both the live and audit-doc lines must be quoted in the failure
      // message so a reviewer can copy-paste the live one back in.
      assert.match(r.stderr, /audit doc: Boot-time count: /);
      assert.match(r.stderr, /live\s+: Boot-time count: /);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("FAILS when the 'Boot-time count' headline is missing entirely (deleted-prose fixture)", () => {
    const tmp = mkdtempSync(join(tmpdir(), "rbac-headline-"));
    try {
      const fixture = join(tmp, "audit.md");
      const original = readFileSync(REAL_AUDIT_DOC, "utf8");
      const stripped = original.replace(/^Boot-time count: .*$\n?/m, "");
      assert.notEqual(stripped, original, "fixture invariant: stripping must change the doc");
      writeFileSync(fixture, stripped, "utf8");

      const r = runGate(fixture);
      assert.notEqual(r.status, 0, `expected gate to FAIL on missing headline, got exit ${r.status}\n--- stdout ---\n${r.stdout}\n--- stderr ---\n${r.stderr}`);
      assert.match(
        r.stderr,
        /audit doc has no 'Boot-time count: \.\.\.' headline/,
        `expected stderr to call out the missing headline, got:\n${r.stderr}`,
      );
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("PASSES against the unmodified audit doc (sanity baseline — proves the failure tests above are not false positives)", () => {
    const r = runGate(REAL_AUDIT_DOC);
    assert.equal(
      r.status,
      0,
      `gate must PASS against the real audit doc, got exit ${r.status}\n--- stdout ---\n${r.stdout}\n--- stderr ---\n${r.stderr}`,
    );
    assert.match(r.stdout, /Section 11 headline count matches live/);
  });
});
