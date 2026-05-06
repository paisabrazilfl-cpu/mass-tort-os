/**
 * Shared helper for the verify-<provider>.ts CLI scripts.
 *
 * Contract:
 *   - Each verify script gates on TEST_<PROVIDER>=1 (e.g. TEST_TWILIO=1).
 *   - Looks up the first active integration row for `provider`,
 *     decrypts credentials, hands them to a check fn, prints PASS/FAIL.
 *   - Exit code 0 = PASS, 0 = SKIPPED (gate off), 1 = FAIL.
 *
 * This keeps every per-provider verify script ~10 lines.
 */
import { db, integrationsTable } from "@workspace/db";
import { and, eq } from "drizzle-orm";
import { getIntegrationCredentialsById, type DecryptedCredentials } from "../routes/integrations";

export interface VerifyContext {
  creds: DecryptedCredentials;
  integrationId: number;
}

export async function runVerify(
  provider: string,
  envFlag: string,
  fn: (ctx: VerifyContext) => Promise<{ ok: boolean; detail?: string }>,
): Promise<void> {
  if (process.env[envFlag] !== "1") {
    console.log(`SKIP ${provider}: set ${envFlag}=1 to run a live check.`);
    process.exit(0);
  }
  const rows = await db
    .select()
    .from(integrationsTable)
    .where(and(eq(integrationsTable.provider, provider), eq(integrationsTable.status, "active")))
    .limit(1);
  const row = rows[0];
  if (!row) {
    console.error(`FAIL ${provider}: no active integration row found.`);
    process.exit(1);
  }
  const creds = await getIntegrationCredentialsById(row.id);
  if (!creds) {
    console.error(`FAIL ${provider}: credentials not loadable.`);
    process.exit(1);
  }
  if (creds._decryption_errors?.length) {
    console.error(`FAIL ${provider}: decryption errors: ${creds._decryption_errors.join(", ")}`);
    process.exit(1);
  }
  try {
    const out = await fn({ creds, integrationId: row.id });
    if (out.ok) {
      console.log(`PASS ${provider}${out.detail ? `: ${out.detail}` : ""}`);
      process.exit(0);
    }
    console.error(`FAIL ${provider}${out.detail ? `: ${out.detail}` : ""}`);
    process.exit(1);
  } catch (err) {
    console.error(`FAIL ${provider}: ${(err as Error).message}`);
    process.exit(1);
  }
}
