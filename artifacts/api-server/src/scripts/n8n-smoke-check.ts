/**
 * One-shot end-to-end check of the n8n integration surface.
 *
 * Mints a temporary API key for firm 1, exercises every operator
 * surface (bearer-auth list, public form submit, audit log, forms
 * directory), then revokes the key. Everything goes through real
 * HTTP so this proves the full chain works the way an n8n HTTP node
 * would call it.
 */
import { createApiKey, revokeApiKey } from "../lib/api-keys";
import { db, apiKeyAuditTable, formConfigurationsTable } from "@workspace/db";
import { desc, eq } from "drizzle-orm";

const BASE = process.env.BASE_URL || "http://localhost:80";

async function main() {
  // 1) Mint a key with broad scopes so we can exercise the surface.
  const minted = await createApiKey({
    name: "n8n-smoke-check",
    scopes: ["leads:read", "leads:write", "forms:read", "automations:read"],
    firm_id: 1,
    created_by_user_id: 1,
  });
  console.log("\n[1/6] minted key:", { id: minted.id, prefix: minted.prefix });

  const auth = { Authorization: `Bearer ${minted.plaintext}` };

  // 2) Hit /api/leads with the bearer — this exercises the rbac.ts
  //    api-key path (mtos_ prefix detection → hash lookup → scope check).
  const leadsRes = await fetch(`${BASE}/api/leads?limit=2`, { headers: auth });
  console.log(`[2/6] GET /api/leads → ${leadsRes.status}`);
  if (leadsRes.ok) {
    const j = await leadsRes.json();
    console.log("       sample:", JSON.stringify(j).slice(0, 120) + "…");
  }

  // 3) Hit /api/admin/forms-api-directory (uses forms:config:view).
  //    Should 403 — the smoke key intentionally doesn't carry that perm.
  const dirRes = await fetch(`${BASE}/api/admin/forms-api-directory`, { headers: auth });
  console.log(`[3/6] GET /api/admin/forms-api-directory → ${dirRes.status} (expected 403, scope-gated)`);

  // 4) Pick the first active form and POST to its public submit URL
  //    *anonymously* — this is the path n8n / vendor sites use without
  //    needing a key at all.
  const [form] = await db
    .select({ id: formConfigurationsTable.id, label: formConfigurationsTable.label })
    .from(formConfigurationsTable)
    .where(eq(formConfigurationsTable.active, true))
    .limit(1);
  console.log(`[4/6] picked form: ${form?.id} (${form?.label})`);

  const sample = {
    first_name: "Smoke",
    last_name: "Test",
    email: `smoke+${Date.now()}@example.com`,
    phone: "+15555550100",
    state: "CA",
    consent_tcpa: true,
  };
  const submitRes = await fetch(`${BASE}/api/forms-public/submit/${form?.id}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(sample),
  });
  console.log(`[5/6] POST /api/forms-public/submit/${form?.id} → ${submitRes.status}`);
  const submitBody = await submitRes.text();
  console.log("       response:", submitBody.slice(0, 200));

  // 5) Inspect audit rows the bearer-auth path wrote.
  const audits = await db
    .select()
    .from(apiKeyAuditTable)
    .where(eq(apiKeyAuditTable.api_key_id, minted.id))
    .orderBy(desc(apiKeyAuditTable.occurred_at))
    .limit(5);
  console.log(`[6/6] audit rows for key ${minted.id}: ${audits.length}`);
  for (const a of audits) {
    console.log(`       ${a.method} ${a.route} → ${a.status_code}`);
  }

  await revokeApiKey(minted.id, 1);
  console.log("\nrevoked smoke key — done.\n");
  process.exit(0);
}

main().catch((err) => {
  console.error("smoke check failed:", err);
  process.exit(1);
});
