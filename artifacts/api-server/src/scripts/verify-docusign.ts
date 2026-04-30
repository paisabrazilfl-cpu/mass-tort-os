import { db, integrationsTable as integrations } from "@workspace/db";
import { eq } from "drizzle-orm";
import { getIntegrationCredentialsById } from "../routes/integrations.js";

async function main() {
  const id = Number(process.argv[2]);
  if (!Number.isInteger(id) || id <= 0) {
    console.error("Usage: tsx verify-docusign.ts <integration_id>");
    process.exit(2);
  }

  const [row] = await db.select().from(integrations).where(eq(integrations.id, id));
  if (!row) {
    console.error(`No integration row with id=${id}`);
    process.exit(2);
  }
  if (row.provider !== "docusign") {
    console.error(`Row ${id} is provider=${row.provider}, expected docusign`);
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

  const token = creds.api_key as string | undefined;
  const accountId = creds.account_sid as string | undefined;
  const apiBase = (creds.api_url as string | undefined) || "https://demo.docusign.net/restapi";

  if (!token || !accountId) {
    console.error("Missing api_key or account_sid after decrypt");
    process.exit(1);
  }

  const userInfoBase = apiBase.includes("demo") ? "https://account-d.docusign.com" : "https://account.docusign.com";

  console.log(`[1/2] GET ${userInfoBase}/oauth/userinfo`);
  const t0 = Date.now();
  const userInfoRes = await fetch(`${userInfoBase}/oauth/userinfo`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const userInfoMs = Date.now() - t0;
  const userInfoBody = await userInfoRes.text();
  console.log(`     -> HTTP ${userInfoRes.status} in ${userInfoMs}ms`);
  if (!userInfoRes.ok) {
    console.error("Token rejected. Body:", userInfoBody.slice(0, 500));
    process.exit(1);
  }
  interface DocusignAccountSummary {
    account_id?: string;
    account_name?: string;
    base_uri?: string;
    is_default?: boolean;
  }
  interface DocusignUserInfo {
    accounts?: DocusignAccountSummary[];
  }
  let userInfo: DocusignUserInfo = {};
  try {
    const parsed: unknown = JSON.parse(userInfoBody);
    if (parsed && typeof parsed === "object") {
      userInfo = parsed as DocusignUserInfo;
    }
  } catch { /* malformed JSON — leave userInfo empty */ }
  const accountMatch = (userInfo.accounts ?? []).find((a) => a.account_id === accountId);
  console.log(`     account_id ${accountId}: ${accountMatch ? "FOUND in token's accounts list" : "NOT in token's accounts list"}`);
  if (accountMatch) {
    console.log(`     account name: ${accountMatch.account_name}, base_uri: ${accountMatch.base_uri}, is_default: ${accountMatch.is_default}`);
  }

  console.log(`[2/2] GET ${apiBase}/v2.1/accounts/${accountId}`);
  const t1 = Date.now();
  const accountRes = await fetch(`${apiBase.replace(/\/$/, "")}/v2.1/accounts/${accountId}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const accountMs = Date.now() - t1;
  const accountBody = await accountRes.text();
  console.log(`     -> HTTP ${accountRes.status} in ${accountMs}ms`);
  if (!accountRes.ok) {
    console.error("Account API call failed. Body:", accountBody.slice(0, 500));
    process.exit(1);
  }
  interface DocusignAccountInfo {
    accountName?: string;
    planName?: string;
    canSendEnvelope?: boolean;
  }
  let account: DocusignAccountInfo = {};
  try {
    const parsed: unknown = JSON.parse(accountBody);
    if (parsed && typeof parsed === "object") {
      account = parsed as DocusignAccountInfo;
    }
  } catch { /* malformed JSON — leave account empty */ }
  console.log(`     account: ${account.accountName} (${account.planName} plan), can_send_envelope=${account.canSendEnvelope}`);

  console.log("\nRESULT: DocuSign token is LIVE. Adapter can send envelopes against this account.");
  process.exit(0);
}

main().catch((err) => { console.error("FATAL:", err); process.exit(1); });
