/**
 * Live verifier for any SMS provider.
 *   Usage: TEST_SMS=1 SMS_PROVIDER=twilio SMS_TO=+15551234567 pnpm tsx src/scripts/verify-sms.ts
 */
import { runVerify } from "./_verify-helper";
import { getSmsAdapter } from "../lib/sms";

const provider = (process.env.SMS_PROVIDER || "").toLowerCase();
const to = process.env.SMS_TO || "";
if (!provider || !to) {
  console.error("Set SMS_PROVIDER and SMS_TO=<E.164 phone>.");
  process.exit(1);
}

await runVerify(provider, "TEST_SMS", async ({ creds }) => {
  const adapter = getSmsAdapter(provider);
  if (!adapter) return { ok: false, detail: `unknown SMS provider ${provider}` };
  const out = await adapter.send(creds, { to, body: "MTOS verify-sms ping" });
  if (!out.ok) return { ok: false, detail: `${out.code} ${out.message}` };
  return { ok: true, detail: `sent id=${out.externalMessageId}` };
});
