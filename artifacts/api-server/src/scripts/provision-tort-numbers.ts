/**
 * provision-tort-numbers.ts — buy/create one dedicated Vapi phone number per
 * tort that doesn't already have one, assign it to that tort's active voice
 * assistant, and record the mapping in `tort_phone_numbers`.
 *
 *   pnpm --filter @workspace/api-server exec tsx src/scripts/provision-tort-numbers.ts
 *
 * Env knobs:
 *   LIMIT=<n>      only create up to n numbers this run (default: all)
 *   AREA_CODE=561  desired area code for the Vapi number (default: none)
 *
 * COSTS MONEY: each created number is a recurring charge. Idempotent — torts
 * that already have a row in tort_phone_numbers are skipped.
 */
import { db, tortVoiceAgentsTable, tortPhoneNumbersTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { resolveProvider, isResolved } from "../lib/provider-router.js";

const SPACING_MS = 6_000;
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const LIMIT = process.env.LIMIT ? parseInt(process.env.LIMIT, 10) : Infinity;
const AREA_CODE = process.env.AREA_CODE?.trim() || undefined;

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

  const agents = await db
    .select({ tort_id: tortVoiceAgentsTable.tort_id, assistant: tortVoiceAgentsTable.vapi_assistant_id, status: tortVoiceAgentsTable.status })
    .from(tortVoiceAgentsTable);
  const haveNumbers = new Set(
    (await db.select({ tort_id: tortPhoneNumbersTable.tort_id }).from(tortPhoneNumbersTable)).map((r) => r.tort_id),
  );

  const todo = agents.filter(
    (a) => a.status === "active" && a.assistant && !haveNumbers.has(a.tort_id),
  );
  console.log(`Torts total: ${agents.length} | already have a number: ${haveNumbers.size} | to provision: ${todo.length}` + (Number.isFinite(LIMIT) ? ` (capped at ${LIMIT})` : ""));

  let created = 0;
  let failed = 0;
  for (let i = 0; i < todo.length && created < LIMIT; i++) {
    const t = todo[i]!;
    const body: Record<string, unknown> = {
      provider: "vapi",
      name: `MTOS ${t.tort_id}`,
      assistantId: t.assistant,
    };
    if (AREA_CODE) body.numberDesiredAreaCode = AREA_CODE;

    let resp: Response;
    console.log(`  -> creating number for ${t.tort_id} (assistant ${String(t.assistant).slice(0, 8)})...`);
    try {
      resp = await fetch("https://api.vapi.ai/phone-number", {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(20_000),
      });
    } catch (err) {
      failed++;
      console.log(`  [${t.tort_id}] NETWORK ERROR: ${String((err as Error).message)}`);
      continue;
    }
    const json = (await resp.json().catch(() => ({}))) as { id?: string; number?: string; message?: unknown };
    if (!resp.ok || !json?.id) {
      failed++;
      console.log(`  [${t.tort_id}] CREATE FAILED HTTP ${resp.status}: ${JSON.stringify(json).slice(0, 240)}`);
      // A quota/limit error is fatal for the batch — stop so we report honestly.
      if (resp.status === 402 || resp.status === 403 || /limit|quota|maximum|exceed/i.test(JSON.stringify(json))) {
        console.log("  -> Looks like an account number limit/billing wall. Stopping batch.");
        break;
      }
      if (i < todo.length - 1) await sleep(SPACING_MS);
      continue;
    }

    // The Vapi number now exists (real spend). If we fail to record it, a
    // rerun would buy ANOTHER number — so surface the orphan loudly for manual
    // recovery instead of silently dropping it.
    try {
      const inserted = await db.insert(tortPhoneNumbersTable).values({
        tort_id: t.tort_id,
        phone_number: json.number ?? json.id,
        vapi_phone_number_id: json.id,
        label: `${t.tort_id} dedicated inbound`,
        active: true,
      }).onConflictDoNothing().returning({ id: tortPhoneNumbersTable.id });
      if (inserted.length === 0) {
        console.log(`  !! ORPHAN: Vapi number ${json.number ?? json.id} (${json.id}) created but mapping conflict on insert for '${t.tort_id}'. Record/release manually to avoid repurchase.`);
      }
    } catch (err) {
      console.log(`  !! ORPHAN: Vapi number ${json.number ?? json.id} (${json.id}) created but DB insert FAILED for '${t.tort_id}': ${String((err as Error).message)}. Record/release manually to avoid repurchase.`);
    }
    created++;
    console.log(`  [${created}] ${t.tort_id} -> ${json.number ?? "(no E.164)"} (${json.id})`);
    if (created < LIMIT && i < todo.length - 1) await sleep(SPACING_MS);
  }

  console.log(`\nDONE. created=${created} failed=${failed} remaining_without_number=${todo.length - created}`);
  process.exit(failed > 0 && created === 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("FATAL:", err);
  process.exit(1);
});
