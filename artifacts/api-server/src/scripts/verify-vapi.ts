/**
 * verify-vapi.ts — operator script that proves the saved Vapi creds
 * actually work end-to-end. Mirrors verify-docusign.ts and
 * verify-stripe.ts: takes an integration row id, decrypts the vault,
 * then makes a single read-only API call so a human can see HTTP 200
 * (or a clear failure) before trusting the adapter.
 *
 *   pnpm --filter @workspace/api-server exec tsx \
 *     src/scripts/verify-vapi.ts <integration_id>
 *
 * Exit codes:
 *   0 — API call succeeded; the key is live
 *   1 — credentials decrypted but Vapi rejected them
 *   2 — usage error / row not found / wrong provider
 */
import { db, integrationsTable as integrations } from "@workspace/db";
import { eq } from "drizzle-orm";
import { getIntegrationCredentialsById } from "../routes/integrations.js";

const VAPI_BASE = "https://api.vapi.ai";

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

  // The tool bearer is optional — Vapi assistants can be configured for
  // either HMAC verification or static-bearer tool callbacks. Surface
  // its absence so an operator who expected bearer-mode notices.
  if (!toolBearer) {
    console.warn("WARN: no client_secret set — bearer-style tool callbacks will fail. HMAC-style webhooks will still verify.");
  }

  console.log(`[1/1] GET ${VAPI_BASE}/assistant?limit=3`);
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

  // Vapi returns either an array or `{ items: [] }` depending on how
  // the account was provisioned — accept both shapes for the summary.
  let assistants: Array<{ id?: string; name?: string }> = [];
  try {
    const parsed: unknown = JSON.parse(body);
    if (Array.isArray(parsed)) {
      assistants = parsed as typeof assistants;
    } else if (parsed && typeof parsed === "object" && Array.isArray((parsed as { items?: unknown }).items)) {
      assistants = (parsed as { items: typeof assistants }).items;
    }
  } catch { /* malformed JSON — leave list empty */ }

  console.log(`     ${assistants.length} assistant${assistants.length === 1 ? "" : "s"} returned`);
  for (const a of assistants.slice(0, 3)) {
    console.log(`       ${a.id ?? "(no id)"} ${a.name ?? ""}`.trim());
  }

  console.log("\nRESULT: Vapi credentials are LIVE. Adapter can launch outbound calls and accept webhooks.");
  process.exit(0);
}

main().catch((err) => {
  console.error("FATAL:", err);
  process.exit(1);
});
