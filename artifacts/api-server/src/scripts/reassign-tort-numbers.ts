/**
 * reassign-tort-numbers.ts — repoint existing dedicated Vapi numbers from one
 * tort to another (no new numbers bought). For each pair, PATCH the Vapi
 * phone-number's assistantId to the target tort's active assistant, then move
 * the `tort_phone_numbers` mapping row to the target tort.
 *
 *   pnpm --filter @workspace/api-server exec tsx src/scripts/reassign-tort-numbers.ts
 *
 * No spend: only reassigns numbers already provisioned.
 */
import { db, tortVoiceAgentsTable, tortPhoneNumbersTable } from "@workspace/db";
import { and, eq } from "drizzle-orm";
import { resolveProvider, isResolved } from "../lib/provider-router.js";

const SPACING_MS = 6_000;
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// from = tort currently holding the number; to = tort that should hold it.
const MAPPING: Array<{ from: string; to: string }> = [
  { from: "asbestos", to: "roundup" },
  { from: "benzene", to: "talcum-powder" },
  { from: "cpap", to: "depo-provera" },
  { from: "hair-relaxer", to: "roblox" },
  { from: "hernia-mesh", to: "afff" },
  { from: "hip-implants", to: "social-media" },
  { from: "ivc-filters", to: "ozempic" },
];

async function main(): Promise<void> {
  const resolved = await resolveProvider("voice");
  if (!isResolved(resolved) || resolved.provider !== "vapi") {
    console.error("Voice provider is not a resolved Vapi integration; aborting.");
    process.exit(1);
  }
  const apiKey = (resolved.credentials as { api_key?: string }).api_key?.trim();
  if (!apiKey) {
    console.error("No Vapi api_key on the resolved voice integration; aborting.");
    process.exit(1);
  }

  let ok = 0;
  let noop = 0;
  let fail = 0;
  for (let i = 0; i < MAPPING.length; i++) {
    const { from, to } = MAPPING[i]!;

    // Idempotent: if the target already holds a dedicated number, this pair has
    // already been applied (or was never needed) — treat as a no-op success.
    const [targetExisting] = await db
      .select({ phone: tortPhoneNumbersTable.phone_number })
      .from(tortPhoneNumbersTable)
      .where(eq(tortPhoneNumbersTable.tort_id, to))
      .limit(1);
    if (targetExisting) {
      noop++;
      console.log(`  [${from} -> ${to}] OK (no-op): '${to}' already holds ${targetExisting.phone}`);
      continue;
    }

    const [num] = await db
      .select({ id: tortPhoneNumbersTable.id, vid: tortPhoneNumbersTable.vapi_phone_number_id, phone: tortPhoneNumbersTable.phone_number })
      .from(tortPhoneNumbersTable)
      .where(eq(tortPhoneNumbersTable.tort_id, from))
      .limit(1);
    if (!num?.vid) {
      fail++;
      console.log(`  [${from} -> ${to}] FAIL: neither '${from}' nor '${to}' has a number to move`);
      continue;
    }
    const [agent] = await db
      .select({ assistant: tortVoiceAgentsTable.vapi_assistant_id })
      .from(tortVoiceAgentsTable)
      .where(and(eq(tortVoiceAgentsTable.tort_id, to), eq(tortVoiceAgentsTable.status, "active")))
      .limit(1);
    if (!agent?.assistant) {
      fail++;
      console.log(`  [${from} -> ${to}] SKIP: no active assistant for '${to}'`);
      continue;
    }

    let resp: Response;
    try {
      resp = await fetch(`https://api.vapi.ai/phone-number/${encodeURIComponent(num.vid)}`, {
        method: "PATCH",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ assistantId: agent.assistant }),
        signal: AbortSignal.timeout(20_000),
      });
    } catch (err) {
      fail++;
      console.log(`  [${from} -> ${to}] PATCH network error: ${String((err as Error).message)}`);
      continue;
    }
    if (!resp.ok) {
      const body = await resp.text().catch(() => "");
      fail++;
      console.log(`  [${from} -> ${to}] PATCH FAILED HTTP ${resp.status}: ${body.slice(0, 160)}`);
      if (i < MAPPING.length - 1) await sleep(SPACING_MS);
      continue;
    }

    await db
      .update(tortPhoneNumbersTable)
      .set({ tort_id: to, label: `${to} dedicated inbound` })
      .where(eq(tortPhoneNumbersTable.id, num.id));
    ok++;
    console.log(`  [${ok}] ${num.phone} reassigned ${from} -> ${to} (assistant ${String(agent.assistant).slice(0, 8)})`);
    if (i < MAPPING.length - 1) await sleep(SPACING_MS);
  }

  console.log(`\nDONE. reassigned=${ok} already-applied=${noop} failed=${fail}`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("FATAL:", err);
  process.exit(1);
});
