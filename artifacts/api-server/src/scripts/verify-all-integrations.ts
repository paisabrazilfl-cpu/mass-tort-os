/**
 * verify-all-integrations.ts — single-shot orchestrator that runs every
 * per-category verifier in this directory against whatever the operator
 * has actually wired up in the integrations vault. Each category script
 * is gated by its own TEST_<X>=1 env flag (so CI can opt-in
 * piecemeal); this orchestrator simply forces all six flags on for the
 * duration of the run and prints a single pass/fail summary.
 *
 * Exit code 0 only when every category script returns 0.
 *
 * Usage:
 *   pnpm --filter @workspace/api-server exec tsx src/scripts/verify-all-integrations.ts
 */
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));

type Category = { name: string; script: string; envFlag: string };

const CATEGORIES: Category[] = [
  { name: "LLM",   script: "verify-llm.ts",   envFlag: "TEST_LLM" },
  { name: "SMS",   script: "verify-sms.ts",   envFlag: "TEST_SMS" },
  { name: "Email", script: "verify-email.ts", envFlag: "TEST_EMAIL" },
  { name: "Fax",   script: "verify-fax.ts",   envFlag: "TEST_FAX" },
  { name: "Voice", script: "verify-voice.ts", envFlag: "TEST_VOICE" },
];

function runOne(c: Category): { name: string; ok: boolean; durationMs: number; tail: string } {
  const start = Date.now();
  const r = spawnSync("npx", ["--yes", "tsx", path.join(HERE, c.script)], {
    cwd: path.resolve(HERE, "../.."),
    env: { ...process.env, [c.envFlag]: "1" },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  return {
    name: c.name,
    ok: r.status === 0,
    durationMs: Date.now() - start,
    tail: out.split("\n").slice(-12).join("\n"),
  };
}

(async () => {
  console.log("verify-all-integrations: running 5 category verifiers (LLM, SMS, Email, Fax, Voice)\n");
  const results = CATEGORIES.map((c) => {
    console.log(`▶ ${c.name} …`);
    const r = runOne(c);
    console.log(`  ${r.ok ? "✓ pass" : "✗ fail"} (${r.durationMs}ms)`);
    return r;
  });

  console.log("\n──────── summary ────────");
  for (const r of results) {
    console.log(`  ${r.ok ? "✓" : "✗"}  ${r.name.padEnd(6)}  ${r.durationMs}ms`);
  }

  const failed = results.filter((r) => !r.ok);
  if (failed.length > 0) {
    console.log(`\n${failed.length} categor${failed.length === 1 ? "y" : "ies"} failed:`);
    for (const f of failed) {
      console.log(`\n── ${f.name} (last 12 lines) ──\n${f.tail}`);
    }
    process.exit(1);
  }
  console.log("\nAll categories OK.");
  process.exit(0);
})();
