/**
 * heal-tort-agents.ts — re-sync the per-tort Vapi voice agents currently in
 * `error` status (typically Vapi HTTP 429 rate-limits left over from a
 * Provision-All burst). Walks the error rows ONE AT A TIME with spacing, and
 * makes up to a few passes (waiting out any 429 burst between passes) so we
 * heal the batch without re-tripping the rate limit.
 *
 *   pnpm --filter @workspace/api-server exec tsx src/scripts/heal-tort-agents.ts
 *
 * Exit codes:
 *   0 — no agents remain in error
 *   1 — at least one agent still in error after all passes
 */
import { db, tortVoiceAgentsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { provisionTortAgent } from "../lib/voice/tort-agent-provisioning.js";

const SPACING_MS = 6_000;
const COOLDOWN_MS = 60_000;
const MAX_PASSES = 3;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function errorTortIds(): Promise<string[]> {
  const rows = await db
    .select({ tort_id: tortVoiceAgentsTable.tort_id })
    .from(tortVoiceAgentsTable)
    .where(eq(tortVoiceAgentsTable.status, "error"));
  return rows.map((r) => r.tort_id);
}

async function main(): Promise<void> {
  let remaining = await errorTortIds();
  console.log(
    `Found ${remaining.length} agent(s) in error: ${remaining.join(", ") || "(none)"}`,
  );

  let pass = 0;
  while (remaining.length > 0 && pass < MAX_PASSES) {
    pass++;
    console.log(`\n=== Pass ${pass} of up to ${MAX_PASSES} (${remaining.length} to heal) ===`);
    for (let i = 0; i < remaining.length; i++) {
      const tortId = remaining[i]!;
      const res = await provisionTortAgent(tortId);
      const tag = res.outcome === "error" ? `ERROR: ${res.error}` : res.outcome.toUpperCase();
      console.log(`  [${i + 1}/${remaining.length}] ${tortId} -> ${tag}`);
      if (i < remaining.length - 1) await sleep(SPACING_MS);
    }

    remaining = await errorTortIds();
    if (remaining.length > 0 && pass < MAX_PASSES) {
      console.log(
        `\n${remaining.length} still in error; cooling down ${COOLDOWN_MS / 1000}s to clear any 429 burst...`,
      );
      await sleep(COOLDOWN_MS);
    }
  }

  if (remaining.length === 0) {
    console.log("\nDONE. All tort voice agents are healed (0 in error).");
    process.exit(0);
  }
  console.log(`\nDONE with ${remaining.length} still in error: ${remaining.join(", ")}`);
  process.exit(1);
}

main().catch((err) => {
  console.error("FATAL:", err);
  process.exit(1);
});
