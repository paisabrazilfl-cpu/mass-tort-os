/**
 * verify-vapi.ts — operator script that proves the saved Vapi creds
 * actually work end-to-end.
 *
 * Two-phase verification:
 *   1) LIVE API   — decrypt vault, GET /assistant?limit=3 so a human can
 *                   see HTTP 200 (or a clear failure).
 *   2) WEBHOOK    — boot the express app in-process and POST a synthetic
 *                   `call-started` event to /api/webhooks/vapi/call-started
 *                   signed with HMAC-SHA256(api_key, body). Asserts a
 *                   call_logs row was created AND that an invalid
 *                   signature is rejected (no row written).
 *
 *   pnpm --filter @workspace/api-server exec tsx \
 *     src/scripts/verify-vapi.ts <integration_id>
 *
 * Exit codes:
 *   0 — both phases pass; the adapter is fully wired
 *   1 — credentials decrypted but a check failed (live or webhook)
 *   2 — usage error / row not found / wrong provider
 */
import crypto from "crypto";
import type { AddressInfo } from "node:net";
import {
  db,
  integrationsTable as integrations,
  firmsTable,
  leadsTable,
  callLogsTable,
} from "@workspace/db";
import { eq } from "drizzle-orm";
import { getIntegrationCredentialsById } from "../routes/integrations.js";

const VAPI_BASE = "https://api.vapi.ai";

async function liveApiPhase(apiKey: string): Promise<void> {
  console.log(`[1/3] GET ${VAPI_BASE}/assistant?limit=3`);
  const t0 = Date.now();
  const res = await fetch(`${VAPI_BASE}/assistant?limit=3`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  const ms = Date.now() - t0;
  const body = await res.text();
  console.log(`     -> HTTP ${res.status} in ${ms}ms`);
  if (!res.ok) {
    console.error("Vapi rejected the api_key. Body:", body.slice(0, 500));
    process.exit(1);
  }

  let assistants: Array<{ id?: string; name?: string }> = [];
  try {
    const parsed: unknown = JSON.parse(body);
    if (Array.isArray(parsed)) {
      assistants = parsed as typeof assistants;
    } else if (parsed && typeof parsed === "object" && Array.isArray((parsed as { items?: unknown }).items)) {
      assistants = (parsed as { items: typeof assistants }).items;
    }
  } catch { /* leave list empty */ }
  console.log(`     ${assistants.length} assistant${assistants.length === 1 ? "" : "s"} returned`);
  for (const a of assistants.slice(0, 3)) {
    console.log(`       ${a.id ?? "(no id)"} ${a.name ?? ""}`.trim());
  }
}

async function webhookPhase(apiKey: string): Promise<void> {
  // Boot the app in-process so the script is self-contained — no need
  // for the operator to keep a workflow running on the side.
  const appMod = (await import("../app.js")) as { default: import("express").Express };
  const app = appMod.default;

  const server = await new Promise<import("node:http").Server>((resolve, reject) => {
    const s = app.listen(0, () => resolve(s));
    s.on("error", reject);
  });
  const addr = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${addr.port}`;

  const TS = Date.now();
  const slug = `verify-vapi-${TS}`;
  const vapiCallId = `vapi_verify_${TS}`;
  let firmId: number | null = null;
  let leadId: number | null = null;

  try {
    // Insert temp firm + lead so the webhook has a valid firm/lead anchor.
    const insertedFirm = await db
      .insert(firmsTable)
      .values({ name: `verify-vapi ${TS}`, slug, subscription_status: "active" })
      .returning({ id: firmsTable.id });
    firmId = insertedFirm[0]?.id ?? null;
    if (!firmId) throw new Error("could not insert verify-vapi firm");

    const insertedLead = await db
      .insert(leadsTable)
      .values({
        name: `verify-vapi lead ${TS}`,
        tort_type: "verify-vapi",
        firm_id: firmId,
      })
      .returning({ id: leadsTable.id });
    leadId = insertedLead[0]?.id ?? null;
    if (!leadId) throw new Error("could not insert verify-vapi lead");
    console.log(`[2/3] inserted temp firm=${firmId} lead=${leadId}; POST signed call-started → /api/webhooks/vapi/call-started`);

    // Build a `call-started` payload; firm_id/lead_id sit in call.metadata
    // so applyVapiEvent can wire the new call_logs row to the right firm.
    const startedAt = new Date().toISOString();
    const payload = {
      type: "call-started",
      call: {
        id: vapiCallId,
        status: "in_progress",
        customer: { number: "+15551230000" },
        startedAt,
        metadata: { firm_id: String(firmId), lead_id: String(leadId) },
      },
    };
    const rawBody = JSON.stringify(payload);
    const sig = crypto.createHmac("sha256", apiKey).update(rawBody).digest("hex");

    const okRes = await fetch(`${baseUrl}/api/webhooks/vapi/call-started`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-vapi-signature": sig },
      body: rawBody,
    });
    const okBody = (await okRes.json()) as { ok?: boolean; note?: string };
    console.log(`     -> ${okRes.status} body=${JSON.stringify(okBody)}`);
    if (okRes.status !== 200 || okBody.note) {
      throw new Error(`webhook rejected the valid event: status=${okRes.status} body=${JSON.stringify(okBody)}`);
    }

    // Re-read call_logs and assert one row exists for our vapi_call_id.
    const [logRow] = await db
      .select()
      .from(callLogsTable)
      .where(eq(callLogsTable.vapi_call_id, vapiCallId))
      .limit(1);
    if (!logRow) {
      throw new Error(`no call_logs row was written for vapi_call_id=${vapiCallId} — webhook did not apply`);
    }
    if (logRow.firm_id !== firmId || logRow.lead_id !== leadId) {
      throw new Error(
        `call_logs row anchors are wrong: expected firm=${firmId} lead=${leadId}, got firm=${logRow.firm_id} lead=${logRow.lead_id}`,
      );
    }
    console.log(`     OK call_logs id=${logRow.id} status=${logRow.status} firm=${logRow.firm_id} lead=${logRow.lead_id}`);

    // Negative path — same payload, different vapi_call_id, mangled signature.
    // Vapi webhook returns HTTP 200 (so the provider stops retrying) but
    // sets `note` to bad_signature/no_signature and skips applyVapiEvent.
    // No call_logs row may be written for the new id.
    const badCallId = `vapi_verify_bad_${TS}`;
    const badPayload = { ...payload, call: { ...payload.call, id: badCallId } };
    const badRaw = JSON.stringify(badPayload);
    console.log(`[3/3] negative test: bad x-vapi-signature must NOT create call_logs row`);
    const badRes = await fetch(`${baseUrl}/api/webhooks/vapi/call-started`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-vapi-signature": "deadbeef" },
      body: badRaw,
    });
    const badBody = (await badRes.json()) as { ok?: boolean; note?: string };
    console.log(`     -> ${badRes.status} body=${JSON.stringify(badBody)}`);
    if (badRes.status !== 200) {
      throw new Error(`bad-signature path returned non-200: ${badRes.status}`);
    }
    if (badBody.note !== "bad_signature" && badBody.note !== "no_signature" && badBody.note !== "no_credentials") {
      throw new Error(`bad-signature path did not surface a rejection note: ${JSON.stringify(badBody)}`);
    }
    const [shouldNotExist] = await db
      .select({ id: callLogsTable.id })
      .from(callLogsTable)
      .where(eq(callLogsTable.vapi_call_id, badCallId))
      .limit(1);
    if (shouldNotExist) {
      throw new Error(`bad-signature event wrote a call_logs row (id=${shouldNotExist.id}) — verifier is OFF`);
    }
    console.log(`     OK no call_logs row for vapi_call_id=${badCallId}; bad-sig event rejected`);
  } finally {
    // Clean up in dependency order (call_logs FK → leads, firms).
    await db.delete(callLogsTable).where(eq(callLogsTable.vapi_call_id, vapiCallId));
    if (leadId !== null) await db.delete(leadsTable).where(eq(leadsTable.id, leadId));
    if (firmId !== null) await db.delete(firmsTable).where(eq(firmsTable.id, firmId));
    await new Promise<void>((res) => server.close(() => res()));
  }
}

async function main() {
  const id = Number(process.argv[2]);
  if (!Number.isInteger(id) || id <= 0) {
    console.error("Usage: tsx verify-vapi.ts <integration_id>");
    process.exit(2);
  }

  const [row] = await db.select().from(integrations).where(eq(integrations.id, id));
  if (!row) {
    console.error(`No integration row with id=${id}`);
    process.exit(2);
  }
  if (row.provider !== "vapi") {
    console.error(`Row ${id} is provider=${row.provider}, expected vapi`);
    process.exit(2);
  }

  const creds = await getIntegrationCredentialsById(id);
  if (!creds) {
    console.error("No credentials retrievable");
    process.exit(1);
  }
  if (creds._decryption_errors?.length) {
    console.error("Decryption errors:", creds._decryption_errors);
    process.exit(1);
  }

  const apiKey = creds.api_key as string | undefined;
  const toolBearer = creds.client_secret as string | undefined;

  if (!apiKey) {
    console.error("Missing api_key after decrypt");
    process.exit(1);
  }
  if (!toolBearer) {
    console.warn("WARN: no client_secret set — bearer-style tool callbacks will fail. HMAC-style webhooks will still verify.");
  }

  await liveApiPhase(apiKey);
  await webhookPhase(apiKey);

  console.log("\nRESULT: Vapi credentials are LIVE and the webhook applies events end-to-end.");
  process.exit(0);
}

main().catch((err) => {
  console.error("FATAL:", err);
  process.exit(1);
});
